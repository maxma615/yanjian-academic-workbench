import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../../server/app';

const roots: string[] = [], apps: Awaited<ReturnType<typeof createApp>>[] = [];
async function setup() {
  await fs.mkdir('.test-data', { recursive: true }); const base = await fs.mkdtemp(path.resolve('.test-data/api-')); roots.push(base);
  const app = await createApp(path.join(base, 'workspace'), { controlDirectory: path.join(base, 'control') }); apps.push(app);
  const client = request.agent(app.app), session = await client.get('/api/session');
  return { app, client, token: session.body.token, base };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it('rejects unauthenticated, foreign-origin and rebinding requests without touching files', async () => {
  const { app, client, token } = await setup();
  expect((await request(app.app).get('/api/state')).status).toBe(401);
  expect((await client.get('/api/state').set('X-Workbench-Token', token).set('Origin', 'https://evil.example')).status).toBe(403);
  expect((await client.get('/api/state').set('X-Workbench-Token', token).set('Host', 'evil.example')).status).toBe(403);
  expect((await client.post('/api/entities').send({ type: 'task', title: 'forbidden' })).status).toBe(401);
  expect((await client.get('/api/state').set('X-Workbench-Token', token)).body.entities).toEqual([]);
});

it('keeps two local application sessions independent when browsers share the localhost cookie jar', async () => {
  const first = await setup(), second = await setup();
  const sessions = await Promise.all([request(first.app.app).get('/api/session'), request(second.app.app).get('/api/session')]);
  const jar = new Map<string, string>();
  for (const session of sessions) for (const header of session.headers['set-cookie'] as unknown as string[]) {
    const cookie = header.split(';')[0], separator = cookie.indexOf('='); jar.set(cookie.slice(0, separator), cookie.slice(separator + 1));
  }
  const cookieHeader = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  expect((await request(first.app.app).get('/api/state').set('Cookie', cookieHeader).set('X-Workbench-Token', first.token)).status).toBe(200);
  expect((await request(second.app.app).get('/api/state').set('Cookie', cookieHeader).set('X-Workbench-Token', second.token)).status).toBe(200);
});

it('serves actual files, handles stale revisions and keeps persistence across API restarts', async () => {
  const { app, client, token, base } = await setup();
  const created = await client.post('/api/entities').set('X-Workbench-Token', token).send({ type: 'note', title: 'API笔记', body: '保存到磁盘' });
  expect(created.status).toBe(201); const entity = created.body.entity;
  expect(await fs.readFile(path.join(base, 'workspace', 'notes', `${entity.id}.md`), 'utf8')).toContain('保存到磁盘');
  expect((await client.put(`/api/entities/${entity.id}`).set('X-Workbench-Token', token).send({ ...entity, title: '新的内容', expectedRevision: 0 })).status).toBe(409);
  await app.close();
  const restarted = await createApp(path.join(base, 'workspace'), { controlDirectory: path.join(base, 'control') }); apps.push(restarted);
  const c = request.agent(restarted.app), session = await c.get('/api/session');
  expect((await c.get('/api/state').set('X-Workbench-Token', session.body.token)).body.entities[0].title).toBe('API笔记');
});

it('downloads a verified backup and restores to an explicitly authorized empty directory', async () => {
  const { client, token, base } = await setup();
  const auth = { 'X-Workbench-Token': token };
  await client.post('/api/entities').set(auth).send({ type: 'task', title: '恢复任务', dueDate: '2026-09-23' });
  const backup = await client.post('/api/backup').set(auth).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
  expect(backup.status).toBe(200); expect(backup.headers['content-type']).toContain('application/zip');
  const base64 = backup.body.toString('base64');
  expect((await client.post('/api/restore/inspect').set(auth).send({ base64 })).body.manifest.files.some((f: any) => f.path.startsWith('tasks/'))).toBe(true);
  const target = path.join(base, '恢复 空目录'); await fs.mkdir(target);
  const selection = await client.post('/api/restore/target').set(auth).send({ path: target });
  expect(selection.status).toBe(200);
  const restored = await client.post('/api/restore').set(auth).send({ base64, targetToken: selection.body.token });
  expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  const state = await client.get('/api/state').set(auth);
  expect(state.body.dataDirectory).toBe(target); expect(state.body.entities[0].title).toBe('恢复任务');
});

it('keeps an activated restore intact when the previous workspace lock cannot be released', async () => {
  const { app, client, token, base } = await setup();
  const auth = { 'X-Workbench-Token': token };
  await client.post('/api/entities').set(auth).send({ type: 'note', title: '已切换的资料', body: '必须保留' });
  const backup = await client.post('/api/backup').set(auth).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
  const target = path.join(base, 'release-failure-target'); await fs.mkdir(target);
  const selected = await client.post('/api/restore/target').set(auth).send({ path: target });
  const previous = app.getWorkspace(), close = previous.close.bind(previous);
  const mockedClose = vi.spyOn(previous, 'close').mockRejectedValueOnce(new Error('lock release failed'));
  try {
    const result = await client.post('/api/restore').set(auth).send({ base64: backup.body.toString('base64'), targetToken: selected.body.token });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(app.getWorkspace().root).toBe(target);
    expect((await client.get('/api/state').set(auth)).body.entities[0].body).toBe('必须保留');
    expect((await fs.readdir(path.join(target, 'notes')))).toHaveLength(1);
  } finally { mockedClose.mockRestore(); await close(); }
});

it('rejects a valid ZIP whose note links to a task instead of a paper before writing the restore target', async () => {
  const { app, client, token, base } = await setup();
  const auth = { 'X-Workbench-Token': token };
  const task = await app.getWorkspace().save({ type: 'task', title: '不是文献' });
  const note = await app.getWorkspace().save({ type: 'note', title: '语义损坏的关联', body: '保留源资料' });
  const source = path.join(base, 'workspace/notes', `${note.entity.id}.md`);
  const original = await fs.readFile(source, 'utf8');
  const invalid = original.replace('"paperIds": []', `"paperIds": ["${task.entity.id}"]`);
  expect(invalid).not.toEqual(original); await fs.writeFile(source, invalid);
  const backup = await client.post('/api/backup').set(auth).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
  const target = path.join(base, 'invalid-reference-target'); await fs.mkdir(target);
  const selected = await client.post('/api/restore/target').set(auth).send({ path: target });
  const restored = await client.post('/api/restore').set(auth).send({ base64: backup.body.toString('base64'), targetToken: selected.body.token });
  expect(restored.status).toBe(400);
  expect(restored.body.error).toContain('文献关联');
  expect(app.getWorkspace().root).toBe(path.join(base, 'workspace'));
  expect(await fs.readdir(target)).toEqual([]);
  expect(await fs.readFile(source, 'utf8')).toBe(invalid);
});

it('desktop mode grants restore targets only through the trusted main-process boundary', async () => {
  await fs.mkdir('.test-data', { recursive: true }); const base = await fs.mkdtemp(path.resolve('.test-data/native-api-')); roots.push(base);
  const app = await createApp(path.join(base, 'workspace'), { controlDirectory: path.join(base, 'control'), nativeDialogs: true }); apps.push(app);
  const client = request.agent(app.app), session = await client.get('/api/session');
  const target = path.join(base, 'native-selected'); await fs.mkdir(target);
  const denied = await client.post('/api/restore/target').set('X-Workbench-Token', session.body.token).send({ path: target });
  expect(denied.status).toBe(403);
  const grant = await app.selectRestoreTarget(target);
  expect(grant.displayPath).toBe(target); expect(grant.token.length).toBeGreaterThan(20);
  expect((await client.post('/api/restore').set('X-Workbench-Token', session.body.token).send({ base64: '', targetToken: grant.token })).status).toBe(403);
  expect(await fs.readdir(target)).toEqual([]);
});
