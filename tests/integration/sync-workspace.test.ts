import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Workspace } from '../../server/workspace';
import { WorkspaceSyncAdapter, recoverSyncApply } from '../../server/sync-workspace';
import { snapshotFingerprint } from '../../src/sync/contracts';
import type { SyncSnapshot } from '../../src/sync/contracts';
import { serializeEntity } from '../../server/entities';
import type { Entity } from '../../src/shared/types';

const roots: string[] = [];
async function fixture() { const root = await fs.mkdtemp(path.resolve('.test-data/sync-workspace-')); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const note = (id: string, body: string): Entity => ({ id, type: 'note', schemaVersion: 1, title: '同步笔记', createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z', revision: 1, body, paperIds: [] });

describe('WorkspaceSyncAdapter', () => {
  it('reads only the approved text snapshot and persists baseline/config in state', async () => {
    const root = await fixture(), workspace = await Workspace.open(root), adapter = new WorkspaceSyncAdapter(workspace), id = '00000000-0000-4000-8000-000000000001';
    await fs.mkdir(path.join(root, 'notes'), { recursive: true }); await fs.mkdir(path.join(root, 'tasks'), { recursive: true });
    await fs.writeFile(path.join(root, 'notes', `${id}.md`), serializeEntity(note(id, '正文')));
    await fs.writeFile(path.join(root, 'tasks', 'excluded.json'), '{}');
    const snapshot = await adapter.readSyncSnapshot();
    expect([...snapshot.files.keys()]).toEqual([`notes/${id}.md`]);
    await adapter.writeSyncBaseline({ schemaVersion: 1, revision: 'r1', files: snapshot.files });
    expect((await adapter.readSyncBaseline())?.revision).toBe('r1');
    expect(await fs.readdir(path.join(root, 'state'))).toEqual(expect.arrayContaining(['sync-baseline.json']));
    await workspace.close();
  });
  it('applies a snapshot through the workspace queue and rejects stale CAS', async () => {
    const root = await fixture(), workspace = await Workspace.open(root), adapter = new WorkspaceSyncAdapter(workspace), id = '00000000-0000-4000-8000-000000000001';
    await fs.mkdir(path.join(root, 'notes'), { recursive: true });
    await fs.writeFile(path.join(root, 'notes', `${id}.md`), serializeEntity(note(id, '旧')));
    const before = await adapter.readSyncSnapshot();
    const changed: SyncSnapshot = { files: new Map([[`notes/${id}.md`, Buffer.from(serializeEntity(note(id, '新')))]]) };
    await adapter.applySyncSnapshot(changed, snapshotFingerprint(before));
    expect((await fs.readFile(path.join(root, 'notes', `${id}.md`), 'utf8')).endsWith('新')).toBe(true);
    await expect(adapter.applySyncSnapshot(before, snapshotFingerprint(before))).rejects.toMatchObject({ code: 'CONFLICT' });
    await workspace.close();
  });
  it('rolls back a prepared journal after an interrupted batch', async () => {
    const root = await fixture(), workspace = await Workspace.open(root), adapter = new WorkspaceSyncAdapter(workspace), id = '00000000-0000-4000-8000-000000000001';
    await fs.mkdir(path.join(root, 'notes'), { recursive: true });
    await fs.writeFile(path.join(root, 'notes', `${id}.md`), serializeEntity(note(id, '原始')));
    const current = await adapter.readSyncSnapshot(), oldBytes = current.files.get(`notes/${id}.md`)!;
    const partial = Buffer.from(serializeEntity(note(id, '部分')));
    const secondId = '00000000-0000-4000-8000-000000000002'; const second = Buffer.from(serializeEntity(note(secondId, '新')));
    const journal = { schemaVersion: 1, phase: 'prepared', entries: [{ path: `notes/${id}.md`, before: Buffer.from(oldBytes).toString('base64'), after: partial.toString('base64') }, { path: `notes/${secondId}.md`, after: second.toString('base64') }] };
    await fs.writeFile(path.join(root, 'state/sync-apply.json'), JSON.stringify(journal));
    await fs.writeFile(path.join(root, 'notes', `${id}.md`), partial); await fs.writeFile(path.join(root, 'notes', `${secondId}.md`), second);
    await recoverSyncApply(root);
    expect(await fs.readFile(path.join(root, 'notes', `${id}.md`))).toEqual(Buffer.from(oldBytes));
    await expect(fs.access(path.join(root, 'notes', `${secondId}.md`))).rejects.toThrow();
    await workspace.close();
  });
});
