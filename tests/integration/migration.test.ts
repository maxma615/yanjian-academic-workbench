import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { MigrationService } from '../../src/migrations/migrate-workspace';
import { createBackup, verifyBackup } from '../../src/backup/backup-service';

const roots: string[] = [];
async function fixture() { await fs.mkdir('.test-data', { recursive: true }); const root = await fs.mkdtemp(path.resolve('.test-data/migration-')); roots.push(root); await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, custom: 'keep' })); await fs.mkdir(path.join(root, 'papers/p1'), { recursive: true }); await fs.writeFile(path.join(root, 'papers/p1/metadata.json'), JSON.stringify({ schemaVersion: 1, paperId: 'p1', unknown: 7 })); return root; }
async function digest(root: string) { const files: string[] = []; async function walk(dir: string) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else files.push(path.relative(root, full)); } } await walk(root); const hash = crypto.createHash('sha256'); for (const file of files.sort()) hash.update(file).update(await fs.readFile(path.join(root, file))); return hash.digest('hex'); }
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); await fs.rm(path.resolve('.test-data/.academic-workbench-migrations'), { recursive: true, force: true }); });

describe('workspace migration', () => {
  it('inspects v1 and leaves a high version read-only', async () => {
    const root = await fixture(); const service = new MigrationService();
    expect(await service.inspect(root)).toMatchObject({ schemaVersion: 1, supported: true, readOnly: false });
    await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 99 }));
    expect(await service.inspect(root)).toMatchObject({ schemaVersion: 99, supported: false, readOnly: true });
    await expect(service.migrate(root)).rejects.toThrow(/unsupported|read-only|version/i);
    const lower = await fixture();
    await expect(new MigrationService({ currentVersion: 1, converters: { 1: async value => value } }).migrate(lower, 2)).rejects.toThrow(/version/i);
  });

  it('backs up before converting with an injected converter and preserves unknown fields', async () => {
    const root = await fixture(); const before = await digest(root); let backupCalled = false;
    const service = new MigrationService({ currentVersion: 2, converters: { 1: async value => { const item = value as Record<string, unknown>; return { ...item, paperIds: [item.paperId], paperId: undefined }; } }, createBackup: async directory => { backupCalled = true; return createBackup(directory); } });
    const migrated = await service.migrate(root, 2);
    expect(backupCalled).toBe(true);
    expect(migrated.backupPath).toBeTruthy();
    await expect(fs.access(migrated.backupPath!)).resolves.toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(root, 'papers/p1/metadata.json'), 'utf8'))).toMatchObject({ paperIds: ['p1'], unknown: 7 });
    expect(JSON.parse(await fs.readFile(path.join(root, 'workspace.json'), 'utf8')).custom).toBe('keep');
    expect(await digest(root)).not.toBe(before);
  });

  it('converts Markdown front matter while preserving the body', async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, 'notes'), { recursive: true });
    await fs.writeFile(path.join(root, 'notes', 'n.md'), '---\n{"schemaVersion":1,"title":"旧"}\n---\n正文保持');
    const service = new MigrationService({ currentVersion: 2, converters: { 1: async value => ({ ...(value as Record<string, unknown>), migrated: true }) }, createBackup });
    await service.migrate(root, 2);
    expect(await fs.readFile(path.join(root, 'notes', 'n.md'), 'utf8')).toContain('正文保持');
    expect(await fs.readFile(path.join(root, 'notes', 'n.md'), 'utf8')).toContain('"migrated": true');
  });

  it('does not change the source when a conversion fails', async () => {
    const root = await fixture(); const before = await digest(root);
    const service = new MigrationService({ currentVersion: 2, converters: { 1: async () => { throw new Error('conversion failed'); } }, createBackup });
    await expect(service.migrate(root, 2)).rejects.toThrow('conversion failed');
    expect(await digest(root)).toBe(before);
  });

  it('rejects a tampered recovery journal without trusting or deleting its paths', async () => {
    const root = await fixture();
    const journal = path.join(path.dirname(root), `.${path.basename(root)}.migration-journal.json`);
    await fs.writeFile(journal, JSON.stringify({ root, stage: '/tmp/unsafe-stage', displaced: '/tmp/unsafe-displaced', backupPath: '/tmp/unsafe.zip', toVersion: 2 }));
    await expect(new MigrationService({ currentVersion: 2 }).migrate(root, 2)).rejects.toThrow(/outside|journal/i);
    expect(await fs.stat(root)).toBeTruthy();
    await fs.rm(journal, { force: true });
  });

  it('detects an authoritative edit made while conversion is staging', async () => {
    const root = await fixture();
    const paper = path.join(root, 'workspace.json');
    const service = new MigrationService({ currentVersion: 2,
      converters: { 1: async (value, context) => { if (context.filePath === 'workspace.json') await fs.writeFile(paper, '{"schemaVersion":1,"editedDuringMigration":true}'); return value; } },
      createBackup,
    });
    await expect(service.migrate(root, 2)).rejects.toThrow(/changed/i);
    expect(JSON.parse(await fs.readFile(paper, 'utf8')).editedDuringMigration).toBe(true);
  });

  it('recovers a crashed rename with a dead PID lock, journal, stage and durable backup', async () => {
    const root = await fixture();
    const operationId = '0123456789abcdef';
    const parent = path.dirname(root), base = path.basename(root);
    const stage = path.join(parent, `.${base}.migration-${operationId}`);
    const displaced = path.join(parent, `.${base}.before-${operationId}`);
    const backupPath = path.join(parent, '.academic-workbench-migrations', base, `${operationId}.before.zip`);
    const journal = path.join(parent, `.${base}.migration-journal.json`);
    const lock = path.join(parent, `.${base}.migration-lock`);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, await createBackup(root));
    await fs.rename(root, displaced);
    await fs.mkdir(stage, { recursive: true });
    await fs.writeFile(lock, JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }));
    await fs.writeFile(journal, JSON.stringify({ root, operationId, stage, displaced, backupPath, fromVersion: 1, toVersion: 2 }));
    const service = new MigrationService({ currentVersion: 2, converters: { 1: async value => value }, createBackup });
    const result = await service.migrate(root, 2);
    expect(result.schemaVersion).toBe(2);
    expect(JSON.parse(await fs.readFile(path.join(root, 'workspace.json'), 'utf8')).schemaVersion).toBe(2);
    await expect(fs.access(result.backupPath!)).resolves.toBeUndefined();
    await expect(fs.access(displaced)).rejects.toThrow();
    await expect(fs.access(journal)).rejects.toThrow();
  });

  it('preserves the predecessor when an interrupted activated migration no longer matches its recorded files', async () => {
    const root = await fixture(), parent = path.dirname(root), base = path.basename(root), operationId = 'fedcba9876543210';
    const stage = path.join(parent, `.${base}.migration-${operationId}`), displaced = path.join(parent, `.${base}.before-${operationId}`);
    const journal = path.join(parent, `.${base}.migration-journal.json`);
    const backupPath = path.join(parent, '.academic-workbench-migrations', base, `${operationId}.before.zip`);
    await fs.mkdir(path.dirname(backupPath), { recursive: true }); await fs.writeFile(backupPath, await createBackup(root));
    await fs.cp(root, displaced, { recursive: true }); roots.push(displaced);
    await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 2, custom: 'keep' }));
    const afterFiles = verifyBackup(await createBackup(root)).manifest.files;
    await fs.writeFile(journal, JSON.stringify({ root, operationId, stage, displaced, backupPath, fromVersion: 1, toVersion: 2, afterFiles }));
    await fs.rm(path.join(root, 'papers/p1/metadata.json'));
    try {
      await expect(new MigrationService({ currentVersion: 2 }).migrate(root)).rejects.toThrow(/predecessor has been preserved/);
      expect(JSON.parse(await fs.readFile(path.join(displaced, 'papers/p1/metadata.json'), 'utf8')).unknown).toBe(7);
      expect(verifyBackup(await fs.readFile(backupPath)).files.has('papers/p1/metadata.json')).toBe(true);
    } finally { await fs.rm(journal, { force: true }); }
  });
});
