import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { Workspace } from '../../server/workspace';
import { TranslationRuntime } from '../../server/translation-runtime';
import type { PaperMetadataSuggestion } from '../../src/shared/paper-import';
import { samplePdf } from '../helpers/sample-pdf';

const roots: string[] = [], workspaces: Workspace[] = [], servers: Server[] = [], runtimes: TranslationRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const workspace of workspaces.splice(0)) await workspace.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const local: PaperMetadataSuggestion = { fields: { title: 'fallback', authors: '', publication: '', doi: '', url: '' }, sources: { title: 'filename' }, warnings: [], firstPageText: 'A Study of Learning\nAlice Chen\n2024', pageCount: 1 };
async function fixture() {
  await fs.mkdir('.test-data', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-data/shared-model-')); roots.push(root);
  const workspace = await Workspace.open(root); workspaces.push(workspace);
  const requests: { key?: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push({ key: request.headers.authorization, body });
    const translation = JSON.parse(body.messages[1].content).segments;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(translation ? { segments: translation.map((block: any) => ({ id: block.id, translation: '学习研究的中文译文。' })) } : { title: { value: 'A Study of Learning', evidence: 'A Study of Learning' }, authors: { value: ['Alice Chen'], evidence: 'Alice Chen' }, year: { value: 2024, evidence: '2024' }, publication: null, doi: null, url: null }) } }] }));
  }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, model: 'shared-model', glossary: [{ source: 'Learning', target: '学习' }], instructions: '忠实翻译' };
  const runtime = new TranslationRuntime({ extract: async () => ({ pageCount: 1, blocks: [{ id: 'one', page: 1, source: 'A study of learning explores memory.', warnings: [] }], warnings: [] }) }); runtimes.push(runtime);
  return { root, workspace, runtime, requests, config };
}
it('uses one saved endpoint, model and key for identification and full-paper translation without storing secrets in metadata', async () => {
  const ctx = await fixture();
  await ctx.runtime.saveSettings(ctx.workspace, { ...ctx.config, apiKey: 'shared-secret' });
  const metadata = await ctx.runtime.inspectMetadata(ctx.workspace, local, ctx.config);
  expect(metadata.fields.authors).toBe('Alice Chen'); expect(metadata.modelLabel).toBe('shared-model');
  const paper = await ctx.workspace.save({ type: 'paper', ...metadata.fields });
  const imported = await ctx.workspace.importPdf(paper.entity.id, 'fixture.pdf', samplePdf(), paper.entity.revision);
  const job = await ctx.runtime.create(ctx.workspace, { paperId: paper.entity.id, attachmentId: imported.entity.attachments![0].id });
  await ctx.runtime.start(ctx.workspace, job.id, true, ctx.config); await ctx.runtime.waitForIdle();
  expect((await ctx.runtime.read(ctx.workspace, job.id)).status).toBe('completed');
  expect(ctx.requests).toHaveLength(2); expect(ctx.requests.every(request => request.key === 'Bearer shared-secret' && request.body.model === 'shared-model')).toBe(true);
  expect(JSON.stringify(metadata)).not.toContain('shared-secret');
  expect(await fs.readFile(path.join(ctx.root, 'state/translation-settings.json'), 'utf8')).not.toContain('shared-secret');
});
it('keeps local import available without a key or explicit destination snapshot and never sends those cases', async () => {
  const ctx = await fixture();
  await ctx.runtime.saveSettings(ctx.workspace, ctx.config);
  const unconfigured = await ctx.runtime.inspectMetadata(ctx.workspace, local, ctx.config);
  expect(unconfigured.fields).toEqual(local.fields); expect(unconfigured.warnings.join(' ')).toContain('密钥');
  await ctx.runtime.saveSettings(ctx.workspace, { ...ctx.config, apiKey: 'shared-secret' });
  const unconfirmed = await ctx.runtime.inspectMetadata(ctx.workspace, local);
  expect(unconfirmed.fields).toEqual(local.fields); expect(unconfirmed.warnings.join(' ')).toContain('本地');
  expect(ctx.requests).toHaveLength(0);
});
it('rejects changed destinations without a request and prevents a canceled import from starting one', async () => {
  const ctx = await fixture();
  await ctx.runtime.saveSettings(ctx.workspace, { ...ctx.config, apiKey: 'shared-secret' });
  await ctx.runtime.saveSettings(ctx.workspace, { ...ctx.config, model: 'changed-model' });
  await expect(ctx.runtime.inspectMetadata(ctx.workspace, local, ctx.config)).rejects.toMatchObject({ status: 409, code: 'TRANSLATION_CONFIG_CHANGED' });
  const abort = new AbortController(); abort.abort();
  await expect(ctx.runtime.inspectMetadata(ctx.workspace, local, { ...ctx.config, model: 'changed-model' }, abort.signal)).rejects.toThrow();
  expect(ctx.requests).toHaveLength(0);
});
it('falls back to local candidates on service and credential errors without exposing their messages', async () => {
  const ctx = await fixture();
  const runtime = new TranslationRuntime({ credentials: { get: async () => { throw new Error('credential-secret'); }, set: async () => {}, delete: async () => {} } }); runtimes.push(runtime);
  await ctx.runtime.saveSettings(ctx.workspace, ctx.config);
  const result = await runtime.inspectMetadata(ctx.workspace, local, ctx.config);
  expect(result.fields).toEqual(local.fields); expect(result.warnings.join(' ')).toContain('本地'); expect(JSON.stringify(result)).not.toContain('credential-secret');
  await ctx.runtime.saveSettings(ctx.workspace, { ...ctx.config, apiKey: 'shared-secret' });
  ctx.requests.length = 0;
  const unavailable = new TranslationRuntime({ identify: async () => { throw new Error('upstream-secret'); } }); runtimes.push(unavailable);
  await unavailable.saveSettings(ctx.workspace, { ...ctx.config, apiKey: 'shared-secret' });
  const fallback = await unavailable.inspectMetadata(ctx.workspace, local, ctx.config);
  expect(fallback.fields).toEqual(local.fields); expect(fallback.warnings.join(' ')).toContain('本地'); expect(JSON.stringify(fallback)).not.toContain('upstream-secret');
  expect(ctx.requests).toHaveLength(0);
});
it('discards a provider result returned after import cancellation', async () => {
  const ctx = await fixture();
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  const runtime = new TranslationRuntime({ identify: async (_config, _key, source) => { began(); await hold; return { ...source, fields: { ...source.fields, title: 'Late result' } }; } }); runtimes.push(runtime);
  await runtime.saveSettings(ctx.workspace, { ...ctx.config, apiKey: 'fixture-key' });
  const controller = new AbortController(); const pending = runtime.inspectMetadata(ctx.workspace, local, ctx.config, controller.signal);
  const canceled = expect(pending).rejects.toThrow(); await started; controller.abort(); release(); await canceled;
  expect((await ctx.workspace.list()).filter(entity => entity.type === 'paper')).toHaveLength(0);
});
