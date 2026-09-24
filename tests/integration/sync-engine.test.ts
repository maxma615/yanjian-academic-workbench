import { describe, expect, it } from 'vitest';
import { SyncEngine } from '../../src/sync/sync-engine';
import type { SyncBaseline, SyncSnapshot, SyncTransport, SyncWorkspaceAdapter } from '../../src/sync/contracts';

const notePath = 'notes/00000000-0000-4000-8000-000000000001.md';
const note = (body: string, id = '00000000-0000-4000-8000-000000000001') => Buffer.from(`---\n{"id":"${id}","type":"note","schemaVersion":1,"title":"同步笔记","createdAt":"2026-09-23T00:00:00.000Z","updatedAt":"2026-09-23T00:00:00.000Z","revision":1,"paperIds":[]}\n---\n${body}`);
class FakeWorkspace implements SyncWorkspaceAdapter {
  constructor(public current: SyncSnapshot, private baseline?: SyncBaseline) {}
  applied: SyncSnapshot[] = [];
  archived: Map<string, Map<string, Uint8Array>> = new Map();
  resolutions = new Map<string, { remoteRevision?: string; remote?: Uint8Array }>();
  async readSyncSnapshot() { return this.current; }
  async applySyncSnapshot(snapshot: SyncSnapshot, expectedFingerprint: string) { void expectedFingerprint; this.current = snapshot; this.applied.push(snapshot); }
  async readSyncBaseline() { return this.baseline; }
  async writeSyncBaseline(value: SyncBaseline) { this.baseline = value; }
  async archiveSyncConflict(id: string, files: Map<string, Uint8Array>) { this.archived.set(id, files); }
  async readSyncResolutions() { return this.resolutions; }
  async recordSyncResolution(path: string, value: { remoteRevision?: string; remote?: Uint8Array }) { this.resolutions.set(path, value); }
  async clearSyncResolutions() { this.resolutions.clear(); }
  get savedBaseline() { return this.baseline; }
}
class FakeTransport implements SyncTransport {
  revision = 'r1'; publishCalls = 0; failPublish = false;
  constructor(public remote: SyncSnapshot) {}
  async readSnapshot() { return { revision: this.revision, files: new Map(this.remote.files) }; }
  async publish(files: Map<string, Uint8Array>, expectedRevision?: string) { this.publishCalls++; if (this.failPublish || expectedRevision !== this.revision) { const error = Object.assign(new Error('remote changed'), { code: 'REMOTE_CHANGED' }); throw error; } this.remote = { revision: 'r2', files: new Map(files) }; this.revision = 'r2'; return { revision: this.revision }; }
}

describe('SyncEngine', () => {
  it('is disabled by default and never contacts a transport', async () => {
    const workspace = new FakeWorkspace({ files: new Map([[notePath, note('local')]]) });
    const transport = new FakeTransport({ files: new Map() });
    const result = await new SyncEngine({ workspace, transport }).syncNow();
    expect(result.status).toBe('disabled'); expect(transport.publishCalls).toBe(0);
  });
  it('merges first connection with an existing remote and records a baseline only after publish', async () => {
    const localPath = 'notes/00000000-0000-4000-8000-000000000001.md';
    const remotePath = 'notes/00000000-0000-4000-8000-000000000002.md';
    const workspace = new FakeWorkspace({ files: new Map([[localPath, note('local')]]) });
    const transport = new FakeTransport({ files: new Map([[remotePath, note('remote', '00000000-0000-4000-8000-000000000002')]]) });
    const result = await new SyncEngine({ enabled: true, workspace, transport }).syncNow();
    expect(result.status).toBe('synced'); expect(workspace.current.files.size).toBe(2); expect(workspace.savedBaseline?.revision).toBe('r2');
  });
  it('keeps both sides and does not publish on conflict', async () => {
    const workspace = new FakeWorkspace({ files: new Map([[notePath, note('local')]]) }, { schemaVersion: 1, revision: 'r1', files: new Map([[notePath, note('base')]]) });
    const transport = new FakeTransport({ revision: 'r1', files: new Map([[notePath, note('remote')]]) });
    const result = await new SyncEngine({ enabled: true, workspace, transport }).syncNow();
    expect(result.status).toBe('conflict'); expect(result.conflicts).toHaveLength(1); expect(transport.publishCalls).toBe(0); expect(workspace.savedBaseline?.revision).toBe('r1');
    const retry = await new SyncEngine({ enabled: true, workspace, transport }).syncNow();
    expect(retry.status).toBe('conflict'); expect(transport.publishCalls).toBe(0);
  });
  it('archives conflict evidence before accepting a local resolution', async () => {
    const workspace = new FakeWorkspace({ files: new Map([[notePath, note('local')]]) }, { schemaVersion: 1, revision: 'r1', files: new Map([[notePath, note('base')]]) });
    const transport = new FakeTransport({ revision: 'r1', files: new Map([[notePath, note('remote')]]) });
    const engine = new SyncEngine({ enabled: true, workspace, transport });
    const result = await engine.syncNow();
    await engine.resolveConflict(result.conflicts[0].id, 'local');
    expect(workspace.archived.get(result.conflicts[0].id)?.size).toBe(3);
    expect([...workspace.current.files.keys()].some(path => path.startsWith('conflicts/'))).toBe(false);
  });
  it('publishes a local resolution against the same remote revision and re-conflicts after a new remote edit', async () => {
    const workspace = new FakeWorkspace({ files: new Map([[notePath, note('local')]]) }, { schemaVersion: 1, revision: 'r1', files: new Map([[notePath, note('base')]]) });
    const transport = new FakeTransport({ revision: 'r1', files: new Map([[notePath, note('remote')]]) });
    const engine = new SyncEngine({ enabled: true, workspace, transport });
    const conflict = await engine.syncNow();
    await engine.resolveConflict(conflict.conflicts[0].id, 'local');
    expect((await engine.syncNow()).status).toBe('synced');
    transport.revision = 'r3'; transport.remote = { revision: 'r3', files: new Map([[notePath, note('new remote')]]) };
    workspace.current = { files: new Map([[notePath, note('local again')]]) };
    expect((await engine.syncNow()).status).toBe('conflict');
  });
  it('keeps local data and baseline unchanged when remote changes before publish', async () => {
    const workspace = new FakeWorkspace({ files: new Map([[notePath, note('local')]]) });
    const transport = new FakeTransport({ files: new Map() }); transport.failPublish = true;
    const result = await new SyncEngine({ enabled: true, workspace, transport }).syncNow();
    expect(result.status).toBe('remote-changed'); expect(workspace.savedBaseline).toBeUndefined(); expect(Buffer.from(workspace.current.files.get(notePath)!).toString()).toContain('local');
  });
  it('does not write credential material through the workspace adapter', async () => {
    let token = 'fake-secret'; let cleared = false;
    const workspace = new FakeWorkspace({ files: new Map() });
    const transport = new FakeTransport({ files: new Map() });
    const engine = new SyncEngine({ enabled: true, workspace, transport, credentials: { getToken: async () => token, clear: async () => { cleared = true; token = ''; } } });
    await engine.disable();
    expect(cleared).toBe(true); expect(workspace.current.files.size).toBe(0);
  });
});
