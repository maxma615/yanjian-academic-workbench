import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../server/app';
import { SyncRuntime } from '../../server/sync-runtime';
import { vi } from 'vitest';
import type { SyncSnapshot, SyncTransport } from '../../src/sync/contracts';
const roots: string[] = [], apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup(native: boolean) {
  await fs.mkdir('.test-data', { recursive: true }); const root = await fs.mkdtemp(path.resolve('.test-data/sync-runtime-')); roots.push(root);
  let token: string | undefined, reads = 0, publishes = 0;
  let remote: SyncSnapshot = { revision: 'r1', files: new Map() };
  const transport: SyncTransport = { readSnapshot: async () => { reads++; return remote; }, publish: async (files, expected) => { expect(expected).toBe(remote.revision); publishes++; remote = { files: new Map(files), revision: `r${publishes+1}` }; return { revision: remote.revision! }; } };
  const app = await createApp(path.join(root, 'workspace'), { controlDirectory: path.join(root, 'control'), sync: native ? { credentials: { getToken: async () => token, setToken: async value => { token = value; }, clear: async () => { token = undefined; } }, transportFactory: () => transport } : undefined }); apps.push(app);
  const client = request.agent(app.app), session = await client.get('/api/session'), auth = { 'X-Workbench-Token': session.body.token };
  return { root, app, client, auth, counts: () => ({ reads, publishes, token }), remote: () => remote };
}
const connection = { destination: { owner: 'fixture-user', repo: 'fixture-texts', branch: 'main' }, token: 'fixture-token-never-network', authorized: true };
it('defaults off, refuses preview credentials and never performs a remote request implicitly', async () => {
  const { client, auth, counts } = await setup(false);
  expect((await client.get('/api/sync').set(auth)).body.enabled).toBe(false);
  expect((await client.post('/api/sync/run').set(auth)).body.status).toBe('disabled');
  expect((await client.post('/api/sync/connect').set(auth).send(connection)).status).toBe(403);
  expect(counts()).toEqual({ reads: 0, publishes: 0, token: undefined });
});
it('syncs whitelisted text through the authenticated API and disconnects without losing local data or baseline', async () => {
  const { root, app, client, auth, counts, remote } = await setup(true);
  const note = await app.getWorkspace().save({ type: 'note', title: '同步笔记', body: '隔离测试资料' });
  await app.getWorkspace().save({ type: 'task', title: '不进入私人仓库的待办' });
  expect((await client.post('/api/sync/connect').set(auth).send({ ...connection, authorized: false })).status).toBe(400);
  expect((await client.post('/api/sync/connect').set(auth).send(connection)).status).toBe(200);
  expect(counts().reads).toBe(0);
  const result = await client.post('/api/sync/run').set(auth);
  expect(result.body.status, JSON.stringify(result.body)).toBe('synced');
  expect([...remote().files.keys()]).toEqual([`notes/${note.entity.id}.md`]);
  const baseline = await fs.readFile(path.join(root, 'workspace/state/sync-baseline.json'));
  expect(JSON.stringify(result.body)).not.toContain(connection.token);
  expect((await client.post('/api/sync/disconnect').set(auth)).body.enabled).toBe(false);
  expect(counts().token).toBeUndefined();
  expect(await fs.readFile(path.join(root, 'workspace/state/sync-baseline.json'))).toEqual(baseline);
  expect((await app.getWorkspace().list())).toHaveLength(2);
  expect((await client.post('/api/sync/run').set(auth)).body.status).toBe('disabled');
  expect(counts().reads).toBe(1);
});

it('disables before clearing and exposes a durable, retryable credential cleanup failure', async () => {
  const { app, counts } = await setup(true);
  let token: string | undefined, failClear = true;
  const runtime = new SyncRuntime({ credentials: { getToken: async () => token, setToken: async value => { token = value; }, clear: async () => { if (failClear) throw new Error('fixture locked'); token = undefined; } } });
  await runtime.connect(app.getWorkspace(), connection);
  const disconnected = await runtime.disconnect(app.getWorkspace());
  expect(disconnected.enabled).toBe(false); expect(disconnected.credentialCleanupPending).toBe(true);
  expect((await runtime.sync(app.getWorkspace())).status).toBe('disabled'); expect(counts().reads).toBe(0);
  failClear = false;
  expect((await runtime.disconnect(app.getWorkspace())).credentialCleanupPending).toBe(false);
  expect(token).toBeUndefined();
});

it('does not retain a credential if enabling the persisted connection fails', async () => {
  const { app } = await setup(true), workspace = app.getWorkspace();
  let token: string | undefined;
  const runtime = new SyncRuntime({ credentials: { getToken: async () => token, setToken: async value => { token = value; }, clear: async () => { token = undefined; } } });
  const original = workspace.syncWriteAtomically.bind(workspace);
  const spy = vi.spyOn(workspace, 'syncWriteAtomically').mockImplementation(async (name, data) => {
    if (name === 'state/sync-config.json' && JSON.parse(String(data)).enabled) throw new Error('fixture disk failure');
    return original(name, data);
  });
  try {
    await expect(runtime.connect(workspace, connection)).rejects.toThrow('已停用同步并清除凭据');
    expect(token).toBeUndefined(); expect((await runtime.status(workspace)).enabled).toBe(false);
  } finally { spy.mockRestore(); }
});

it('fails closed when the system cipher is unavailable and supports a safe slash branch', async () => {
  const { app } = await setup(true); let stores = 0;
  const options = { credentials: { getToken: async () => undefined, setToken: async () => { stores++; }, clear: async () => undefined } };
  const unavailable = new SyncRuntime({ ...options, credentialsAvailable: () => false });
  expect((await unavailable.status(app.getWorkspace())).available).toBe(false);
  await expect(unavailable.connect(app.getWorkspace(), connection)).rejects.toThrow('系统安全存储'); expect(stores).toBe(0);
  const available = new SyncRuntime(options);
  expect((await available.connect(app.getWorkspace(), { ...connection, destination: { ...connection.destination, branch: 'research/notes' } })).destination?.branch).toBe('research/notes');
});
