import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../server/app';
import { Workspace } from '../../server/workspace';
import { createBackup, verifyBackup } from '../../src/backup/backup-service';
import { metadataPdf } from '../helpers/metadata-pdf';
import { listFiles } from '../../server/fs-safe';
import type { TranslationRuntimeOptions } from '../../server/translation-runtime';

const roots: string[] = [], apps: Awaited<ReturnType<typeof createApp>>[] = [], readers: Workspace[] = [];
const fields = { title: '核对后的学习研究', authors: 'Alice Smith, Bob Jones', year: 2022, publication: 'Journal of Example Research', doi: '10.1234/memory.2022.14', url: 'https://doi.org/10.1234/memory.2022.14' };
const pdf = metadataPdf();
async function setup(translation?: TranslationRuntimeOptions) {
  await fs.mkdir('.test-data', { recursive: true });
  const base = await fs.mkdtemp(path.resolve('.test-data/paper-import-')); roots.push(base);
  const app = await createApp(path.join(base, 'workspace'), { controlDirectory: path.join(base, 'control'), translation }); apps.push(app);
  const client = request.agent(app.app), session = await client.get('/api/session');
  const auth = { 'X-Workbench-Token': session.body.token };
  const state = (await client.get('/api/state').set(auth)).body;
  const input = { requestId: randomUUID(), workspaceId: state.workspaceId, dataDirectory: state.dataDirectory, name: 'C:\\papers\\study.pdf', base64: pdf.toString('base64'), fields };
  return { base, app, client, auth, input };
}
afterEach(async () => { vi.restoreAllMocks(); for (const reader of readers.splice(0)) await reader.close(); for (const app of apps.splice(0)) await app.close(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('PDF-first import confirmation', () => {
  it('uses the shared configured model for inspection only, then confirms locally without another model request', async () => {
    let calls = 0;
    const ctx = await setup({ identify: async (config, key, local) => {
      expect(config.baseUrl).toBe('https://api.deepseek.com'); expect(key).toBe('local-fixture-key');
      expect(local.firstPageText).toContain('Alice Smith'); calls++;
      return { ...local, fields: { ...local.fields, title: 'Model-confirmed title' }, sources: { ...local.sources, title: 'model' }, modelLabel: config.model };
    } });
    const config = { baseUrl: 'https://api.deepseek.com', model: 'fixture-model', instructions: '', glossary: [] };
    expect((await ctx.client.put('/api/translation/settings').set(ctx.auth).send({ ...config, apiKey: 'local-fixture-key' })).status).toBe(200);
    const inspected = await ctx.client.post('/api/papers/inspect-pdf').set(ctx.auth).send({ ...ctx.input, expectedConfig: config });
    expect(inspected.status).toBe(200); expect(inspected.body.sources.title).toBe('model');
    expect(inspected.body.modelLabel).toBe('fixture-model'); expect(inspected.body.fields.title).toBe('Model-confirmed title');
    expect((await ctx.client.post('/api/papers/import-pdf').set(ctx.auth).send(ctx.input)).status).toBe(201); expect(calls).toBe(1);
    const mismatch = await ctx.client.post('/api/papers/inspect-pdf').set(ctx.auth).send({ ...ctx.input, expectedConfig: { ...config, model: 'changed-model' } });
    expect(mismatch.status).toBe(409); expect(calls).toBe(1);
  });

  it('cancels the upstream inspection when the browser disconnects while allowing local CRUD during the request', async () => {
    let began!: () => void, aborted!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const canceled = new Promise<void>(resolve => { aborted = resolve; });
    const ctx = await setup({ identify: async (_config, _key, _local, signal) => {
      began(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(new Error('request aborted')); }, { once: true }));
      throw new Error('unreachable');
    } });
    const config = { baseUrl: 'https://api.deepseek.com', model: 'fixture-model', instructions: '', glossary: [] };
    await ctx.client.put('/api/translation/settings').set(ctx.auth).send({ ...config, apiKey: 'local-fixture-key' });
    const server = ctx.app.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
    const base = `http://127.0.0.1:${address.port}`;
    const session = await fetch(`${base}/api/session`), cookie = session.headers.get('set-cookie')!.split(';')[0], { token } = await session.json() as { token: string };
    const controller = new AbortController();
    const pending = fetch(`${base}/api/papers/inspect-pdf`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-workbench-token': token }, body: JSON.stringify({ ...ctx.input, expectedConfig: config }), signal: controller.signal }).catch(() => undefined);
    try {
      await started;
      expect((await ctx.client.post('/api/entities').set(ctx.auth).send({ type: 'task', title: '识别中仍能安排待办' })).status).toBe(201);
      controller.abort(); await pending;
      await Promise.race([canceled, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('upstream was not canceled')), 2000))]);
      expect((await ctx.app.getWorkspace().list()).map(item => item.type)).toEqual(['task']);
    } finally { controller.abort(); await pending; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('inspects a real PDF without creating records and requires authenticated local access', async () => {
    const ctx = await setup();
    expect((await request(ctx.app.app).post('/api/papers/inspect-pdf').send(ctx.input)).status).toBe(401);
    const inspected = await ctx.client.post('/api/papers/inspect-pdf').set(ctx.auth).send(ctx.input);
    expect(inspected.status).toBe(200);
    expect(inspected.body.fields).toMatchObject({ title: 'Working memory and learning', authors: 'Alice Smith, Bob Jones', year: 2022 });
    expect(inspected.body.firstPageText).toContain('Abstract');
    expect((await ctx.app.getWorkspace().list())).toEqual([]);
    expect((await listFiles(ctx.input.dataDirectory, 'papers'))).toEqual([]);
  });

  it('saves the confirmed fields and exact PDF together, normalizes Windows filenames, and survives restart', async () => {
    const ctx = await setup();
    const imported = await ctx.client.post('/api/papers/import-pdf').set(ctx.auth).send(ctx.input);
    expect(imported.status).toBe(201);
    const entity = imported.body.entity;
    expect(entity).toMatchObject({ type: 'paper', ...fields, revision: 1, readingStatus: 'unread' });
    expect(entity.attachments).toHaveLength(1); expect(entity.attachments[0].name).toBe('study.pdf');
    expect((await ctx.app.getWorkspace().readAttachment(entity.id, entity.attachments[0].id)).bytes).toEqual(pdf);
    expect(await listFiles(ctx.input.dataDirectory, 'state/paper-imports')).toEqual([]);
    await ctx.app.close();
    const again = await createApp(path.join(ctx.base, 'workspace'), { controlDirectory: path.join(ctx.base, 'control') }); apps.push(again);
    const saved = (await again.getWorkspace().list())[0]; expect(saved.id).toBe(entity.id); expect(saved.title).toBe(fields.title);
    expect((await again.getWorkspace().readAttachment(saved.id, saved.attachments![0].id)).bytes).toEqual(pdf);
  });

  it('deduplicates concurrent and restarted retries, rejects reuse for different input, and never recreates a deleted import', async () => {
    const ctx = await setup();
    const responses = await Promise.all([1, 2].map(() => ctx.client.post('/api/papers/import-pdf').set(ctx.auth).send(ctx.input)));
    expect(responses.map(item => item.status)).toEqual([201, 201]);
    expect(responses[0].body.entity.id).toBe(responses[1].body.entity.id);
    expect(await ctx.app.getWorkspace().list()).toHaveLength(1);
    const mismatch = await ctx.client.post('/api/papers/import-pdf').set(ctx.auth).send({ ...ctx.input, fields: { ...fields, title: '不同的确认内容' } });
    expect(mismatch.status).toBe(409);
    await ctx.app.close();
    const again = await createApp(path.join(ctx.base, 'workspace'), { controlDirectory: path.join(ctx.base, 'control') }); apps.push(again);
    const second = request.agent(again.app), session = await second.get('/api/session'), auth = { 'X-Workbench-Token': session.body.token };
    const retried = await second.post('/api/papers/import-pdf').set(auth).send(ctx.input);
    expect(retried.body.entity.id).toBe(responses[0].body.entity.id);
    await again.getWorkspace().remove(retried.body.entity.id, 1);
    expect((await second.post('/api/papers/import-pdf').set(auth).send(ctx.input)).status).toBe(409);
    expect(await again.getWorkspace().list()).toEqual([]);
  });

  it('rejects malformed PDF, invalid fields, wrong workspace and read-only access without a partial paper', async () => {
    const ctx = await setup();
    for (const mutation of [{ base64: Buffer.from('%PDF-1.4 broken').toString('base64') }, { name: 'study.txt' }, { fields: { ...fields, title: '' } }, { fields: { ...fields, authors: 9 } }, { requestId: '../../escape' }]) {
      const response = await ctx.client.post('/api/papers/import-pdf').set(ctx.auth).send({ ...ctx.input, ...mutation }); expect(response.status).toBe(400);
    }
    for (const mutation of [{ workspaceId: randomUUID() }, { dataDirectory: `${ctx.input.dataDirectory}/elsewhere` }]) {
      expect((await ctx.client.post('/api/papers/import-pdf').set(ctx.auth).send({ ...ctx.input, ...mutation })).status).toBe(409);
    }
    const other = await createApp(ctx.input.dataDirectory, { controlDirectory: path.join(ctx.base, 'other-control') }); apps.push(other);
    const client = request.agent(other.app), session = await client.get('/api/session');
    expect((await client.post('/api/papers/import-pdf').set('X-Workbench-Token', session.body.token).send(ctx.input)).status).toBe(423);
    expect(await ctx.app.getWorkspace().list()).toEqual([]); expect(await listFiles(ctx.input.dataDirectory, 'papers')).toEqual([]);
  });

  it('rolls back staged files when publication fails and a retry can succeed', async () => {
    const ctx = await setup();
    // A real filesystem obstruction blocks the final directory publication, after staging.
    await fs.mkdir(path.join(ctx.input.dataDirectory, 'papers'), { recursive: true });
    await fs.writeFile(path.join(ctx.input.dataDirectory, 'papers', ctx.input.requestId), 'existing unrelated file');
    const response = await ctx.client.post('/api/papers/import-pdf').set(ctx.auth).send(ctx.input);
    expect(response.status).toBe(409); expect(await ctx.app.getWorkspace().list()).toEqual([]);
    expect(await listFiles(ctx.input.dataDirectory, 'state/paper-imports')).toEqual([]);
    expect(await fs.readFile(path.join(ctx.input.dataDirectory, 'papers', ctx.input.requestId), 'utf8')).toBe('existing unrelated file');
    await fs.rm(path.join(ctx.input.dataDirectory, 'papers', ctx.input.requestId));
    expect((await ctx.client.post('/api/papers/import-pdf').set(ctx.auth).send(ctx.input)).status).toBe(201);
  });

  it('includes the completed import in a verified backup and restores it without changing PDF bytes', async () => {
    const ctx = await setup();
    const saved = await ctx.client.post('/api/papers/import-pdf').set(ctx.auth).send(ctx.input); expect(saved.status).toBe(201);
    const archive = await ctx.app.getWorkspace().exclusive(() => createBackup(ctx.input.dataDirectory));
    const files = verifyBackup(archive).files;
    expect([...files.keys()].filter(item => item.startsWith('papers/'))).toHaveLength(2);
    expect(Buffer.from(files.get(saved.body.entity.attachments[0].path)!)).toEqual(pdf);
    const destination = path.join(ctx.base, '恢复 空目录'); await fs.mkdir(destination);
    const target = await ctx.app.selectRestoreTarget(destination);
    await ctx.app.restoreBackup(archive, target.token);
    const current = await ctx.app.getWorkspace().list(); expect(current).toHaveLength(1);
    expect(current[0].title).toBe(fields.title);
    expect((await ctx.app.getWorkspace().readAttachment(current[0].id, current[0].attachments![0].id)).bytes).toEqual(pdf);
    expect((await ctx.client.post('/api/papers/import-pdf').set(ctx.auth).send(ctx.input)).status).toBe(409);
  });

  it('rejects a compromised writer lock and removes its uncommitted staging files', async () => {
    const ctx = await setup(), workspace = ctx.app.getWorkspace();
    // A writer lock replacement is an actual externally visible storage fault.
    const held = path.join(workspace.root, 'state/writer.lock');
    const moved = path.join(ctx.base, 'original-writer-lock');
    await fs.rename(held, moved); await fs.mkdir(held);
    try {
      const response = await ctx.client.post('/api/papers/import-pdf').set(ctx.auth).send(ctx.input);
      expect(response.status).toBe(423); expect(response.body.code).toBe('LOCK_COMPROMISED');
      expect(await workspace.list()).toEqual([]); expect(await listFiles(workspace.root, 'state/paper-imports')).toEqual([]);
    } finally { await fs.rm(held, { recursive: true, force: true }); await fs.rename(moved, held); }
  });
});
