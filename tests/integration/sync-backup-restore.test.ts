import { it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../../server/app';
import { WorkspaceSyncAdapter } from '../../server/sync-workspace';
import { SyncEngine } from '../../src/sync/sync-engine';
import { serializeEntity } from '../../server/entities';
import { createBackup, verifyBackup } from '../../src/backup/backup-service';
import type { SyncSnapshot, SyncTransport } from '../../src/sync/contracts';
import { samplePdf } from '../helpers/sample-pdf';

it('restores a complete research workspace including resolved conflicts, deletion history, PDF and same-day logs byte-for-byte', async () => {
  await fs.mkdir('.test-data', { recursive: true }); const root = await fs.mkdtemp(path.resolve('.test-data/sync-full-restore-'));
  const app = await createApp(path.join(root, 'workspace'), { controlDirectory: path.join(root, 'control'), nativeDialogs: true });
  let sequence = 1, remote: SyncSnapshot = { revision: 'r1', files: new Map() };
  const transport: SyncTransport = { readSnapshot: async () => remote, publish: async (files, expected) => { expect(expected).toBe(remote.revision); remote = { revision: `r${++sequence}`, files: new Map(files) }; return { revision: remote.revision! }; } };
  try {
    const workspace = app.getWorkspace();
    const paper = (await workspace.save({ type: 'paper', title: '中文文献' })).entity;
    await workspace.importPdf(paper.id, '研究 附件.pdf', samplePdf(), paper.revision);
    const note = (await workspace.save({ type: 'note', title: '关联笔记', body: '基线', paperIds: [paper.id] })).entity;
    for (const title of ['早间日志', '晚间日志']) await workspace.save({ type: 'log', title, date: '2026-09-23', body: '同日不同研究记录' });
    const task = (await workspace.save({ type: 'task', title: '删除的待办' })).entity; await workspace.remove(task.id, task.revision);
    await workspace.save({ type: 'event', title: '组会', allDay: true, start: '2026-09-23', end: '2026-09-23' });
    const engine = new SyncEngine({ enabled: true, workspace: new WorkspaceSyncAdapter(workspace), transport });
    expect((await engine.syncNow()).status).toBe('synced');
    await workspace.save({ ...note, body: '必须保留的本地冲突原文', expectedRevision: note.revision }, note.id);
    remote = { revision: `r${++sequence}`, files: new Map(remote.files) };
    remote.files.set(`notes/${note.id}.md`, Buffer.from(serializeEntity({ ...note, revision: 2, body: '采用的远端冲突原文', updatedAt: new Date().toISOString() })));
    const conflict = await engine.syncNow(); expect(conflict.status).toBe('conflict');
    await engine.resolveConflict(conflict.conflicts[0].id, 'remote');
    const bytes = await workspace.exclusive(() => createBackup(workspace.root)), verified = verifyBackup(bytes);
    expect([...verified.files.keys()].some(name => name.startsWith('deletion-snapshots/sync-conflicts/'))).toBe(true);
    expect([...verified.files.values()].some(value => Buffer.from(value).toString().includes('必须保留的本地冲突原文'))).toBe(true);
    expect([...verified.files.keys()].some(name => name === `tombstones/task/${task.id}.json`)).toBe(true);
    expect([...remote.files.keys()].some(name => /^(tasks|events|state|deletion-snapshots)\//.test(name) || name.endsWith('.pdf'))).toBe(false);
    const target = path.join(root, '中文 完整恢复'); await fs.mkdir(target);
    const grant = await app.selectRestoreTarget(target); await app.restoreBackup(bytes, grant.token);
    for (const [name, value] of verified.files) expect(await fs.readFile(path.join(target, name))).toEqual(Buffer.from(value));
    const restored = app.getWorkspace(), items = await restored.list();
    expect(items.find(entity => entity.id === note.id)?.body).toBe('采用的远端冲突原文');
    expect(items.filter(entity => entity.type === 'log')).toHaveLength(2);
    expect(items.find(entity => entity.id === task.id)).toBeUndefined();
    const attachment = items.find(entity => entity.id === paper.id)!.attachments![0];
    expect((await restored.readAttachment(paper.id, attachment.id)).bytes).toEqual(samplePdf());
    expect(restored.indexStatus).toBe('ready');
    await expect(fs.access(path.join(target, 'state/sync-baseline.json'))).rejects.toThrow();
  } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
});
