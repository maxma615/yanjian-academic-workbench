import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../server/app';
import { samplePdf } from '../helpers/sample-pdf';
import { createBackup, verifyBackup } from '../../src/backup/backup-service';
import { readTranslationJob } from '../../server/translation-storage';

const roots: string[] = [], apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup() {
  await fs.mkdir('.test-data', { recursive: true }); const root = await fs.mkdtemp(path.resolve('.test-data/translation-api-')); roots.push(root);
  const app = await createApp(path.join(root, 'workspace'), {
    controlDirectory: path.join(root, 'control'),
    translation: {
      extract: async () => ({ pageCount: 1, blocks: [{ id: 'p1', page: 1, source: 'Research result 42.', warnings: [] }], warnings: [] }),
      translate: async (_config, _key, blocks) => blocks.map(b => ({ id: b.id, translation: '研究结果为 42。', warnings: [] })),
    },
  }); apps.push(app);
  const client = request.agent(app.app), session = await client.get('/api/session'), auth = { 'X-Workbench-Token': session.body.token };
  const paper = await app.getWorkspace().save({ type: 'paper', title: 'API测试论文' });
  const pdf = await app.getWorkspace().importPdf(paper.entity.id, 'fixture.pdf', samplePdf(), paper.entity.revision);
  return { app, client, auth, root, paper: pdf.entity };
}
it('exposes translation only to the authenticated local UI, and exports completed bilingual text', async () => {
  const { client, auth, paper } = await setup();
  expect((await client.get('/api/translation/settings')).status).toBe(401);
  expect((await client.get('/api/translations').set(auth).set('Origin', 'https://untrusted.example')).status).toBe(403);
  const settings = await client.put('/api/translation/settings').set(auth).send({ baseUrl: 'https://api.deepseek.com', model: 'fixture', glossary: [], instructions: '', apiKey: 'fixture-key' });
  expect(settings.status).toBe(200); expect(JSON.stringify(settings.body)).not.toContain('fixture-key');
  const created = await client.post('/api/translations').set(auth).send({ paperId: paper.id, attachmentId: paper.attachments![0].id });
  expect(created.status).toBe(201); expect(created.body.status).toBe('ready');
  const id = created.body.id;
  expect((await client.post(`/api/translations/${id}/start`).set(auth).send({ authorized: false })).status).toBe(400);
  expect((await client.post(`/api/translations/${id}/start`).set(auth).send({ authorized: true, expectedConfig: { baseUrl: 'https://api.deepseek.com', model: 'fixture', glossary: [], instructions: '' } })).status).toBe(200);
  await expect.poll(async () => (await client.get(`/api/translations/${id}`).set(auth)).body.status).toBe('completed');
  const exported = await client.get(`/api/translations/${id}/export`).set(auth);
  expect(exported.status).toBe(200); expect(exported.text).toContain('Research result 42.'); expect(exported.text).toContain('研究结果为 42。');
  const list = await client.get('/api/translations').set(auth);
  expect(list.body.jobs[0].completedBlocks).toBe(1);
});
it('restoring while a request is active aborts it before switching workspaces and never automatically resumes', async () => {
  await fs.mkdir('.test-data', { recursive: true }); const root = await fs.mkdtemp(path.resolve('.test-data/translation-restore-')); roots.push(root);
  let calls = 0, aborted = false, began!: () => void;
  const started = new Promise<void>(r => { began = r; });
  const app = await createApp(path.join(root, 'workspace'), { controlDirectory: path.join(root, 'control'), translation: {
    extract: async () => ({ pageCount: 1, blocks: [{ id: 'p1', page: 1, source: 'Stored original.', warnings: [] }], warnings: [] }),
    translate: async (_config, _key, _blocks, _context, signal) => {
      calls++; began();
      return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }); });
    },
  } }); apps.push(app);
  const client = request.agent(app.app), session = await client.get('/api/session'), auth = { 'X-Workbench-Token': session.body.token };
  await client.put('/api/translation/settings').set(auth).send({ baseUrl: 'https://api.deepseek.com', model: 'fixture', glossary: [], instructions: '', apiKey: 'restore-secret' });
  const paper = await app.getWorkspace().save({ type: 'paper', title: '恢复中的论文' });
  const pdf = await app.getWorkspace().importPdf(paper.entity.id, 'fixture.pdf', samplePdf(), paper.entity.revision);
  const created = await client.post('/api/translations').set(auth).send({ paperId: paper.entity.id, attachmentId: pdf.entity.attachments![0].id });
  const id = created.body.id;
  await client.post(`/api/translations/${id}/start`).set(auth).send({ authorized: true, expectedConfig: { baseUrl: 'https://api.deepseek.com', model: 'fixture', glossary: [], instructions: '' } }); await started;
  const old = app.getWorkspace(), bytes = await old.exclusive(() => createBackup(old.root));
  expect([...verifyBackup(bytes).files.values()].some(b => Buffer.from(b).includes(Buffer.from('restore-secret')))).toBe(false);
  const destination = path.join(root, 'restored'); await fs.mkdir(destination);
  const grant = await app.selectRestoreTarget(destination);
  await app.restoreBackup(bytes, grant.token);
  expect(aborted).toBe(true); expect(calls).toBe(1); expect(app.getWorkspace().root).toBe(destination);
  const job = (await client.get(`/api/translations/${id}`).set(auth)).body;
  expect(job.status).toBe('paused'); expect(job.blocks[0].source).toBe('Stored original.'); expect(job.blocks[0].translation).toBeUndefined();
  expect((await readTranslationJob(app.getWorkspace(), id)).status).toBe('running');
  expect((await client.get('/api/translation/settings').set(auth)).body.model).not.toBe('fixture');
});
