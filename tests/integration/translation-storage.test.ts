import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../../server/workspace';
import { hash } from '../../server/fs-safe';
import { createBackup, verifyBackup, RestoreManager } from '../../src/backup/backup-service';
import { MigrationService } from '../../src/migrations/migrate-workspace';
import { WorkspaceSyncAdapter } from '../../server/sync-workspace';
import { snapshotFingerprint } from '../../src/sync/contracts';
import { samplePdf } from '../helpers/sample-pdf';
import type { TranslationJob } from '../../src/shared/translation';

const roots: string[] = [], opened: Workspace[] = [];
const storage = () => import('../../server/translation-storage');
async function directory() {
  await fs.mkdir('.test-data', { recursive: true });
  const container = await fs.mkdtemp(path.resolve('.test-data/translation-storage-')); roots.push(container);
  const root = path.join(container, 'workspace'); await fs.mkdir(root); return root;
}
async function open(root: string) { const ws = await Workspace.open(root); opened.push(ws); return ws; }
async function fixture() {
  const ws = await open(await directory());
  const paper = (await ws.save({ type: 'paper', title: '本地学术论文', authors: 'Researcher' })).entity;
  const attached = (await ws.importPdf(paper.id, '研究论文.pdf', samplePdf(), paper.revision)).entity;
  const attachment = attached.attachments![0], now = new Date().toISOString();
  const job: TranslationJob = {
    schemaVersion: 1, id: randomUUID(), paperId: paper.id, attachmentId: attachment.id,
    paperTitle: paper.title, sourceName: attachment.name, sourceHash: attachment.sha256,
    createdAt: now, updatedAt: now, status: 'ready', pageCount: 1,
    blocks: [{ id: 'p1-b1', page: 1, source: 'Offline research fixture', warnings: [] }],
    warnings: [], ruleVersion: 'academic-en-zh-v1',
  };
  return { ws, paper: attached, job, relative: `papers/${paper.id}/translations/${job.id}.json` };
}
afterEach(async () => {
  for (const ws of opened.splice(0)) await ws.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('translation authority and format compatibility', () => {
  it('opens translation-capable v2 workspaces while rejecting future formats', async () => {
    const { ws } = await fixture(), root = ws.root;
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'workspace.json'), 'utf8'));
    await ws.close();
    await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify({ ...manifest, schemaVersion: 2 }));
    const current = await open(root);
    expect((await current.list()).length).toBe(1);
    await current.close();
    await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify({ ...manifest, schemaVersion: 99 }));
    await expect(Workspace.open(root)).rejects.toThrow(/版本/);
  });

  it('includes translation authority in complete backup but excludes local settings and credentials', async () => {
    const { ws, job, relative } = await fixture();
    await fs.mkdir(path.dirname(path.join(ws.root, relative)), { recursive: true });
    await fs.writeFile(path.join(ws.root, relative), JSON.stringify(job));
    await fs.writeFile(path.join(ws.root, 'state/translation-settings.json'), '{"apiKey":"never-back-up"}');
    const backup = verifyBackup(await ws.exclusive(() => createBackup(ws.root)));
    expect(backup.files.get(relative)).toEqual(new Uint8Array(Buffer.from(JSON.stringify(job))));
    expect([...backup.files.keys()].some(name => name.startsWith('state/') || name.includes('credential'))).toBe(false);
  });

  it('creates a verified v1 backup before first translation and persists partial work across restart', async () => {
    const { ws, job, relative } = await fixture(), api = await storage();
    job.status = 'paused'; job.blocks[0].translation = '离线研究样例';
    await api.saveTranslationJob(ws, job);
    const metadata = JSON.parse(await fs.readFile(path.join(ws.root, 'workspace.json'), 'utf8'));
    expect(metadata.schemaVersion).toBe(2);
    const before = verifyBackup(await fs.readFile(path.join(ws.root, 'state/format-upgrades/before-translations-v2.zip')));
    expect(JSON.parse(Buffer.from(before.files.get('workspace.json')!).toString()).schemaVersion).toBe(1);
    expect(before.files.has(relative)).toBe(false);
    expect(before.files.has(`papers/${job.paperId}/metadata.json`)).toBe(true);
    const oldReader = new MigrationService({ currentVersion: 1 });
    expect(await oldReader.inspect(ws.root)).toMatchObject({ supported: false, readOnly: true });
    const root = ws.root; await ws.close();
    await expect(oldReader.migrate(root)).rejects.toThrow(/unsupported/);
    const reopened = await open(root);
    expect((await api.readTranslationJob(reopened, job.id)).blocks[0].translation).toBe('离线研究样例');
    expect((await api.listTranslationJobs(reopened)).map(item => item.id)).toEqual([job.id]);
    expect((await reopened.list()).map(item => item.id)).toEqual([job.paperId]);
  });

  it.each([
    ['future task schema', (job: any) => { job.schemaVersion = 99; }],
    ['unsafe job identity', (job: any) => { job.id = '../escape'; }],
    ['unknown secret field', (job: any) => { job.apiKey = 'secret'; }],
    ['nested secret field', (job: any) => { job.config = { baseUrl: 'https://api.example.com/v1', model: 'test', glossary: [], instructions: '', apiKey: 'secret' }; }],
    ['duplicate segments', (job: any) => { job.blocks.push({ ...job.blocks[0] }); }],
    ['invalid page mapping', (job: any) => { job.blocks[0].page = 2; }],
    ['completed missing translation', (job: any) => { job.status = 'completed'; }],
    ['empty stored translation', (job: any) => { job.blocks[0].translation = ''; }],
    ['whitespace stored translation', (job: any) => { job.blocks[0].translation = '  \n'; }],
    ['oversized source block', (job: any) => { job.blocks[0].source = 'x'.repeat(100_001); }],
  ])('rejects %s without upgrading or writing a job', async (_label, alter) => {
    const { ws, job, relative } = await fixture(), api = await storage(); alter(job);
    await expect(api.saveTranslationJob(ws, job)).rejects.toThrow();
    await expect(fs.access(path.join(ws.root, relative))).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(ws.root, 'workspace.json'), 'utf8')).schemaVersion).toBe(1);
  });

  it('refuses a mismatched source identity or changed PDF before saving', async () => {
    const { ws, job, relative } = await fixture(), api = await storage();
    await expect(api.saveTranslationJob(ws, { ...job, sourceHash: '0'.repeat(64) })).rejects.toThrow(/来源|附件|校验/);
    await fs.writeFile(path.join(ws.root, `papers/${job.paperId}/attachments/${job.attachmentId}.pdf`), '%PDF-tampered');
    await expect(api.saveTranslationJob(ws, job)).rejects.toThrow(/附件|校验/);
    await expect(fs.access(path.join(ws.root, relative))).rejects.toThrow();
  });

  it('leaves the v1 workspace untouched if its verified upgrade backup cannot be stored', async () => {
    const { ws, job, relative } = await fixture(), api = await storage();
    const originalMetadata = await fs.readFile(path.join(ws.root, 'workspace.json'));
    await fs.mkdir(path.join(ws.root, 'state/format-upgrades/before-translations-v2.zip'), { recursive: true });
    await expect(api.saveTranslationJob(ws, job)).rejects.toThrow();
    expect(await fs.readFile(path.join(ws.root, 'workspace.json'))).toEqual(originalMetadata);
    await expect(fs.access(path.join(ws.root, relative))).rejects.toThrow();
    expect(hash((await ws.readAttachment(job.paperId, job.attachmentId)).bytes)).toBe(job.sourceHash);
  });

  it('refuses to replace an existing task source and excludes stale temporary files', async () => {
    const { ws, job, relative } = await fixture(), api = await storage(); await api.saveTranslationJob(ws, job);
    const changed = structuredClone(job); changed.blocks[0].source = 'A different source.';
    await expect(api.saveTranslationJob(ws, changed)).rejects.toThrow(/原文|来源/);
    await fs.writeFile(path.join(ws.root, `${relative}.aborted.tmp`), 'incomplete write');
    expect((await api.readTranslationJob(ws, job.id)).blocks[0].source).toBe('Offline research fixture');
    expect(verifyBackup(await createBackup(ws.root)).files.has(`${relative}.aborted.tmp`)).toBe(false);
  });

  it('rejects credential-shaped fields added externally before creating a backup', async () => {
    const { ws, job, relative } = await fixture(), api = await storage(); await api.saveTranslationJob(ws, job);
    await fs.writeFile(path.join(ws.root, relative), JSON.stringify({ ...job, apiKey: 'must-not-enter-backup' }));
    await expect(createBackup(ws.root)).rejects.toThrow(/字段|格式/);
  });

  it('allows read-only reading but rejects writes and replacement writer locks', async () => {
    const { ws, job } = await fixture(), api = await storage(); await api.saveTranslationJob(ws, job);
    const reader = await open(ws.root);
    expect((await api.listTranslationJobs(reader))[0].id).toBe(job.id);
    await expect(api.saveTranslationJob(reader, job)).rejects.toThrow(/只读/);
    await fs.rm(path.join(ws.root, 'state/writer.lock'), { recursive: true });
    const replacement = await open(ws.root);
    await expect(api.saveTranslationJob(ws, job)).rejects.toMatchObject({ code: 'LOCK_COMPROMISED' });
    expect(replacement.readOnly).toBe(false);
  });

  it('archives translations with a deleted paper and never recreates the source directory', async () => {
    const { ws, job, paper, relative } = await fixture(), api = await storage(); await api.saveTranslationJob(ws, job);
    await ws.remove(paper.id, paper.revision);
    expect(await api.listTranslationJobs(ws)).toEqual([]);
    await expect(api.saveTranslationJob(ws, job)).rejects.toThrow(/不存在|删除/);
    await expect(fs.access(path.join(ws.root, 'papers', paper.id))).rejects.toThrow();
    const files = verifyBackup(await ws.exclusive(() => createBackup(ws.root))).files;
    const preserved = [...files.keys()].find(name => name.startsWith('deletion-snapshots/') && name.endsWith(relative));
    expect(preserved).toBeTruthy();
    expect(JSON.parse(Buffer.from(files.get(preserved!)!).toString()).id).toBe(job.id);
  });

  it('rejects orphaned or future task documents during restore validation', async () => {
    const { ws, job, relative } = await fixture(), api = await storage(); await api.saveTranslationJob(ws, job);
    await fs.writeFile(path.join(ws.root, relative), JSON.stringify({ ...job, schemaVersion: 2 }));
    await expect(api.validateWorkspaceTranslations(ws)).rejects.toThrow(/版本|格式/);
    await fs.writeFile(path.join(ws.root, relative), JSON.stringify(job));
    await fs.rm(path.join(ws.root, `papers/${job.paperId}/metadata.json`));
    expect(await api.listTranslationJobs(ws)).toEqual([]);
    await expect(api.validateWorkspaceTranslations(ws)).rejects.toThrow(/孤立|文献|来源/);
  });

  it('roundtrips text and PDF through real empty-directory restore without syncing translation content', async () => {
    const { ws, job, relative } = await fixture(), api = await storage();
    job.status = 'completed'; job.blocks[0].translation = '离线研究样例'; await api.saveTranslationJob(ws, job);
    const snapshot = await new WorkspaceSyncAdapter(ws).readSyncSnapshot();
    expect(snapshot.files.has(relative)).toBe(false);
    const backup = await ws.exclusive(() => createBackup(ws.root));
    const target = await directory(); let activated: Workspace | undefined;
    const restore = new RestoreManager({ getActiveRoot: () => ws.root,
      validateStaged: async root => { const staged = await open(root); try { await api.validateWorkspaceTranslations(staged); } finally { await staged.close(); } },
      activate: async root => { activated = await open(root); },
    });
    const selected = await restore.selectTarget(target); await restore.restore(backup, selected.token);
    expect((await api.readTranslationJob(activated!, job.id)).blocks[0].translation).toBe('离线研究样例');
    expect(hash((await activated!.readAttachment(job.paperId, job.attachmentId)).bytes)).toBe(job.sourceHash);
  });

  it('restores historical translations after a valid synchronized paper deletion without reviving it', async () => {
    const { ws, job } = await fixture(), api = await storage(); await api.saveTranslationJob(ws, job);
    const adapter = new WorkspaceSyncAdapter(ws), before = await adapter.readSyncSnapshot();
    const metadataPath = `papers/${job.paperId}/metadata.json`, files = new Map(before.files);
    files.delete(metadataPath);
    files.set(`tombstones/paper/${job.paperId}.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, entityType: 'paper', entityId: job.paperId, originalRelativePath: metadataPath, deletedAt: new Date().toISOString(), contentHash: hash(before.files.get(metadataPath)!) })));
    await adapter.applySyncSnapshot({ files }, snapshotFingerprint(before));
    expect(await api.listTranslationJobs(ws)).toEqual([]);
    await expect(api.validateWorkspaceTranslations(ws)).resolves.toBeUndefined();
    await expect(api.saveTranslationJob(ws, job)).rejects.toThrow(/不存在|删除/);
    const backup = await ws.exclusive(() => createBackup(ws.root));
    const target = await directory(); let activated: Workspace | undefined;
    const restore = new RestoreManager({ getActiveRoot: () => ws.root,
      validateStaged: async root => { const staged = await open(root); try { await api.validateWorkspaceTranslations(staged); } finally { await staged.close(); } },
      activate: async root => { activated = await open(root); },
    });
    await restore.restore(backup, (await restore.selectTarget(target)).token);
    expect(await api.listTranslationJobs(activated!)).toEqual([]);
    expect(await activated!.list()).toEqual([]);
    await fs.writeFile(path.join(target, `papers/${job.paperId}/attachments/${job.attachmentId}.pdf`), '%PDF-corrupt-history');
    await expect(api.validateWorkspaceTranslations(activated!)).rejects.toThrow(/校验|哈希/);
  });

  it('upgrades an offline v1 workspace with the default migration without changing entity schemas', async () => {
    const { ws, job } = await fixture(); await ws.close();
    const migrated = await new MigrationService().migrate(ws.root);
    expect(migrated.schemaVersion).toBe(2);
    expect(verifyBackup(migrated.backup).files.has(`papers/${job.paperId}/metadata.json`)).toBe(true);
    const reopened = await open(ws.root);
    expect((await reopened.get(job.paperId)).schemaVersion).toBe(1);
    expect(await new MigrationService().inspect(ws.root)).toMatchObject({ supported: true, readOnly: false });
    if (migrated.backupPath) roots.push(path.dirname(migrated.backupPath));
  });

  it('keeps tombstone conflict hashes and every non-workspace authority byte intact during the default upgrade', async () => {
    const { ws, paper } = await fixture();
    await ws.save({ type: 'task', title: '继续保留的实验任务' });
    await ws.remove(paper.id, paper.revision);
    const tombstone = await fs.readFile(path.join(ws.root, `tombstones/paper/${paper.id}.json`));
    const conflictId = randomUUID(), originalRelativePath = `papers/${paper.id}/metadata.json`;
    const copyPath = `conflicts/${conflictId}/${originalRelativePath}`;
    await fs.mkdir(path.dirname(path.join(ws.root, copyPath)), { recursive: true });
    await fs.writeFile(path.join(ws.root, copyPath), tombstone);
    await fs.writeFile(path.join(ws.root, `conflicts/${conflictId}/manifest.json`), JSON.stringify({
      schemaVersion: 1, conflictId, source: 'remote', sourceKind: 'tombstone', createdAt: new Date().toISOString(),
      entityType: 'paper', entityId: paper.id, originalRelativePath, contentHash: hash(tombstone),
    }));
    expect((await new WorkspaceSyncAdapter(ws).readSyncSnapshot()).files.has(copyPath)).toBe(true);
    const before = verifyBackup(await createBackup(ws.root)).files;
    await ws.close();
    await new MigrationService().migrate(ws.root);
    const reopened = await open(ws.root);
    await expect(new WorkspaceSyncAdapter(reopened).readSyncSnapshot()).resolves.toBeDefined();
    const after = verifyBackup(await createBackup(ws.root)).files;
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [relative, bytes] of before) {
      if (relative !== 'workspace.json') expect(after.get(relative), relative).toEqual(bytes);
    }
    expect(JSON.parse(Buffer.from(after.get('workspace.json')!).toString()).schemaVersion).toBe(2);
  });
});
