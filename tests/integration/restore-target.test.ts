import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createBackup, RestoreManager } from '../../src/backup/backup-service';

const roots: string[] = [];
async function dir(prefix: string) { await fs.mkdir('.test-data', { recursive: true }); const root = await fs.mkdtemp(path.resolve(`.test-data/${prefix}-`)); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('restore target authorization and commit', () => {
  it('restores into a selected empty directory and activates only after validation', async () => {
    const active = await dir('active'); const target = await dir('恢复 目录');
    await fs.writeFile(path.join(active, 'workspace.json'), '{"schemaVersion":1}');
    await fs.writeFile(path.join(active, 'notes.md'), 'active');
    const backup = await createBackup(active);
    let activated = '';
    const manager = new RestoreManager({
      getActiveRoot: () => active,
      validateStaged: async root => expect(await fs.readFile(path.join(root, 'workspace.json'), 'utf8')).toContain('schemaVersion'),
      activate: async root => { activated = root; },
    });
    const selected = await manager.selectTarget(target);
    expect(selected.displayPath).toBe(path.resolve(target));
    expect(selected.token).not.toContain(target);
    const result = await manager.restore(backup, selected.token);
    expect(result.dataDirectory).toBe(path.resolve(target));
    expect(activated).toBe(path.resolve(target));
    expect(await fs.readFile(path.join(target, 'workspace.json'), 'utf8')).toContain('schemaVersion');
  });

  it('rejects the active directory, non-empty targets, parent/child targets, and selection replacement', async () => {
    const active = await dir('active'); const child = await dir('child'); const nonEmpty = await dir('nonempty');
    await fs.writeFile(path.join(active, 'workspace.json'), '{"schemaVersion":1}');
    await fs.writeFile(path.join(nonEmpty, 'existing.txt'), 'keep');
    const manager = new RestoreManager({ getActiveRoot: () => active, validateStaged: async () => {}, activate: async () => {} });
    await expect(manager.selectTarget(active)).rejects.toThrow(/active|current|directory/i);
    await expect(manager.selectTarget(nonEmpty)).rejects.toThrow(/empty|non-empty/i);
    await expect(manager.selectTarget(path.dirname(active))).rejects.toThrow(/active|parent/i);
    const selected = await manager.selectTarget(child);
    await fs.rm(child, { recursive: true, force: true }); await fs.mkdir(child);
    const backup = await createBackup(active);
    await expect(manager.restore(backup, selected.token)).rejects.toThrow(/changed|identity|authorized|empty/i);
    expect(await fs.readdir(child)).toEqual([]);
  });

  it('leaves the target and active data unchanged when staged validation fails', async () => {
    const active = await dir('active'); const target = await dir('target');
    await fs.writeFile(path.join(active, 'workspace.json'), '{"schemaVersion":1}');
    const before = await fs.readFile(path.join(active, 'workspace.json'), 'utf8');
    const manager = new RestoreManager({ getActiveRoot: () => active, validateStaged: async () => { throw new Error('invalid workspace'); }, activate: async () => { throw new Error('must not activate'); } });
    const selected = await manager.selectTarget(target);
    await expect(manager.restore(await createBackup(active), selected.token)).rejects.toThrow('invalid workspace');
    expect(await fs.readFile(path.join(active, 'workspace.json'), 'utf8')).toBe(before);
    expect(await fs.readdir(target)).toEqual([]);
  });

  it('keeps activation-created unknown files when activation throws', async () => {
    const active = await dir('active'); const target = await dir('target');
    await fs.writeFile(path.join(active, 'workspace.json'), '{"schemaVersion":1}');
    const manager = new RestoreManager({
      getActiveRoot: () => active,
      validateStaged: async () => {},
      activate: async root => { await fs.mkdir(path.join(root, 'state')); await fs.writeFile(path.join(root, 'state', 'generated.sqlite'), 'generated'); throw new Error('activation failed'); },
    });
    const selected = await manager.selectTarget(target);
    await expect(manager.restore(await createBackup(active), selected.token)).rejects.toThrow('activation failed');
    expect(await fs.readFile(path.join(target, 'state', 'generated.sqlite'), 'utf8')).toBe('generated');
  });

  it('rejects a symbolic-link target before creating a restore staging result', async () => {
    const active = await dir('active'); const target = await dir('target'); const link = path.join(path.dirname(target), 'target-link');
    await fs.symlink(target, link);
    const manager = new RestoreManager({ getActiveRoot: () => active, validateStaged: async () => {}, activate: async () => {} });
    await expect(manager.selectTarget(link)).rejects.toThrow(/symbolic|link/i);
    await fs.unlink(link);
  });

  it('canonicalizes a directory selected through a trusted symbolic-link parent alias', async () => {
    const active = await dir('active'); const target = await dir('target'); const alias = path.join(path.dirname(target), 'alias');
    await fs.rm(alias, { recursive: true, force: true });
    await fs.symlink(path.dirname(target), alias);
    const manager = new RestoreManager({ getActiveRoot: () => active, validateStaged: async () => {}, activate: async () => {} });
    const selected = await manager.selectTarget(path.join(alias, path.basename(target)));
    expect(selected.displayPath).toBe(path.resolve(target));
    await fs.unlink(alias);
  });
});
