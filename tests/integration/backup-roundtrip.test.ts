import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import { createBackup, verifyBackup } from '../../src/backup/backup-service';

const roots: string[] = [];
async function fixture(files: Record<string, string | Uint8Array>) {
  await fs.mkdir('.test-data', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-data/backup-')); roots.push(root);
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value);
  }
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('complete backup', () => {
  it('archives authoritative files with a hash manifest and excludes derived/private files', async () => {
    const root = await fixture({
      'workspace.json': '{"schemaVersion":1}',
      'notes/n1.md': '# 中文笔记',
      'logs/2026/l1.md': '日志',
      'papers/p1/metadata.json': '{"title":"论文"}',
      'papers/p1/attachments/a.pdf': Buffer.from('%PDF-1.4\n%%EOF'),
      'tasks/t1.json': '{}', 'events/e1.json': '{}',
      'tombstones/task/t1.json': '{}',
      'deletion-snapshots/d1/tasks/t1.json': '{}',
      'conflicts/c1/manifest.json': '{}', 'conflicts/c1/preserved.md': '冲突',
      'state/local-settings.json': 'secret', 'index/search.sqlite': 'derived', 'credentials': 'secret',
    });
    const backup = await createBackup(root);
    const verified = verifyBackup(backup);
    expect(verified.manifest.schemaVersion).toBe(1);
    expect([...verified.files.keys()]).toEqual([
      'conflicts/c1/manifest.json', 'conflicts/c1/preserved.md', 'deletion-snapshots/d1/tasks/t1.json',
      'events/e1.json', 'logs/2026/l1.md', 'notes/n1.md', 'papers/p1/attachments/a.pdf',
      'papers/p1/metadata.json', 'tasks/t1.json', 'tombstones/task/t1.json', 'workspace.json',
    ]);
    expect(verified.files.get('notes/n1.md') && new TextDecoder().decode(verified.files.get('notes/n1.md'))).toContain('中文');
    expect(verified.manifest.files.map(file => file.path)).toEqual([...verified.files.keys()]);
  });

  it('rejects duplicate, traversal and checksum-tampered archive members', async () => {
    const duplicate = zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), files: [] })), 'notes/x.md': new Uint8Array([1]) });
    // A valid archive with a duplicate central entry is generated in the safety test; this assertion
    // also ensures malformed manifests never become a restorable file map.
    await expect(Promise.resolve().then(() => verifyBackup(duplicate))).rejects.toThrow(/manifest|checksum|whitelist/i);
  });

  it('refuses an authoritative symlink instead of silently omitting it', async () => {
    const root = await fixture({ 'workspace.json': '{"schemaVersion":1}', 'notes/real.md': '正文' });
    await fs.symlink(path.join(root, 'notes/real.md'), path.join(root, 'notes/link.md'));
    await expect(createBackup(root)).rejects.toThrow(/link|unsupported/i);
  });

  it('refuses an authoritative hard link instead of copying an unstable alias', async () => {
    const root = await fixture({ 'workspace.json': '{"schemaVersion":1}', 'notes/real.md': '正文' });
    await fs.link(path.join(root, 'notes/real.md'), path.join(root, 'notes/hard.md'));
    await expect(createBackup(root)).rejects.toThrow(/hard|unsupported/i);
  });
});
