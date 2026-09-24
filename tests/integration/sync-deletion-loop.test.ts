import { it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../../server/workspace';
import { WorkspaceSyncAdapter } from '../../server/sync-workspace';
import { SyncEngine } from '../../src/sync/sync-engine';
import type { SyncSnapshot, SyncTransport } from '../../src/sync/contracts';
import { createBackup, verifyBackup } from '../../src/backup/backup-service';

it.each([
  { remoteDeleted: true, choice: 'local' as const, restore: true },
  { remoteDeleted: true, choice: 'remote' as const, restore: false },
  { remoteDeleted: false, choice: 'local' as const, restore: false },
  { remoteDeleted: false, choice: 'remote' as const, restore: true },
])('preserves delete/edit history across two actual workspaces and resolves $choice (remoteDeleted=$remoteDeleted)', async ({ remoteDeleted, choice, restore }) => {
  await fs.mkdir('.test-data', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-data/sync-delete-loop-'));
  const first = await Workspace.open(path.join(root, 'first')), second = await Workspace.open(path.join(root, 'second'));
  let revision = 1, remote: SyncSnapshot = { revision: 'r1', files: new Map() };
  const transport: SyncTransport = {
    readSnapshot: async () => ({ revision: remote.revision, files: new Map(remote.files) }),
    publish: async (files, expected) => { expect(expected).toBe(remote.revision); remote = { revision: `r${++revision}`, files: new Map(files) }; return { revision: remote.revision! }; },
  };
  const firstEngine = new SyncEngine({ enabled: true, workspace: new WorkspaceSyncAdapter(first), transport });
  const secondEngine = new SyncEngine({ enabled: true, workspace: new WorkspaceSyncAdapter(second), transport });
  try {
    const entity = (await first.save({ type: 'note', title: '删除与编辑并发', body: '共同基线' })).entity;
    expect((await firstEngine.syncNow()).status).toBe('synced'); expect((await secondEngine.syncNow()).status).toBe('synced');
    if (remoteDeleted) {
      await first.remove(entity.id, entity.revision);
      await second.save({ ...entity, body: '不能丢失的编辑内容', expectedRevision: entity.revision }, entity.id);
    } else {
      await first.save({ ...entity, body: '不能丢失的编辑内容', expectedRevision: entity.revision }, entity.id);
      await second.remove(entity.id, entity.revision);
    }
    expect((await firstEngine.syncNow()).status).toBe('synced');
    const conflicted = await secondEngine.syncNow(); expect(conflicted.status).toBe('conflict'); expect(conflicted.conflicts).toHaveLength(1);
    await secondEngine.resolveConflict(conflicted.conflicts[0].id, choice);
    const local = await second.list();
    expect(local.some(item => item.id === entity.id)).toBe(false);
    expect(local).toHaveLength(restore ? 1 : 0);
    if (restore) { expect(local[0].body).toBe('不能丢失的编辑内容'); expect(local[0].revision).toBe(1); }
    const tombstone = `tombstones/note/${entity.id}.json`;
    expect(JSON.parse(await fs.readFile(path.join(second.root, tombstone), 'utf8')).entityId).toBe(entity.id);
    const archive = verifyBackup(await createBackup(second.root));
    expect([...archive.files.values()].some(bytes => Buffer.from(bytes).toString().includes('不能丢失的编辑内容'))).toBe(true);
    const synced = await secondEngine.syncNow(); expect(synced.status).toBe('synced');
    expect(remote.files.has(tombstone)).toBe(true); expect(remote.files.has(`notes/${entity.id}.md`)).toBe(false);
    expect([...remote.files.keys()].filter(name => name.startsWith('notes/'))).toHaveLength(restore ? 1 : 0);
    expect([...remote.files.keys()].some(name => name.startsWith('deletion-snapshots/'))).toBe(false);
  } finally { await first.close(); await second.close(); await fs.rm(root, { recursive: true, force: true }); }
});
