import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../../server/workspace';
import { TranslationRuntime, type TranslationRuntimeOptions } from '../../server/translation-runtime';
import { samplePdf } from '../helpers/sample-pdf';
import { readTranslationJob, saveTranslationJob } from '../../server/translation-storage';
import { AppError } from '../../server/fs-safe';

const roots: string[] = [], workspaces: Workspace[] = [], runtimes: TranslationRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const ws of workspaces.splice(0)) await ws.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const config = { baseUrl: 'https://api.deepseek.com', model: 'fixture-model', glossary: [{ source: 'sample', target: '样本' }], instructions: '' };
async function setup(options: TranslationRuntimeOptions = {}) {
  await fs.mkdir('.test-data', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-data/translation-runtime-')); roots.push(root);
  const workspace = await Workspace.open(path.join(root, 'workspace')); workspaces.push(workspace);
  const paper = await workspace.save({ type: 'paper', title: 'Research fixture' });
  const pdf = await workspace.importPdf(paper.entity.id, 'test.pdf', samplePdf(), paper.entity.revision);
  const runtime = new TranslationRuntime({
    extract: async () => ({ pageCount: 2, blocks: [1, 2, 3].map(n => ({ id: `p${n}`, page: n === 3 ? 2 : 1, source: `Source ${n}. `.repeat(220), warnings: [] })), warnings: [] }),
    ...options,
  }); runtimes.push(runtime);
  return { root, workspace, runtime, paperId: pdf.entity.id, attachmentId: pdf.entity.attachments![0].id };
}
it('creates an offline task, stores no API key in documents and requires explicit start authorization', async () => {
  let calls = 0;
  const ctx = await setup({ translate: async (_config, _key, blocks) => { calls++; return blocks.map(b => ({ id: b.id, translation: '完整中文译文', warnings: [] })); } });
  const settings = await ctx.runtime.saveSettings(ctx.workspace, { ...config, apiKey: 'secret-fixture-key' });
  expect(settings.hasApiKey).toBe(true); expect(settings.keyStorage).toBe('session');
  expect(JSON.stringify(settings)).not.toContain('secret-fixture-key');
  const job = await ctx.runtime.create(ctx.workspace, ctx);
  expect(job.status).toBe('ready'); expect(calls).toBe(0);
  expect(await fs.readFile(path.join(ctx.workspace.root, 'state/translation-settings.json'), 'utf8')).not.toContain('secret-fixture-key');
  await expect(ctx.runtime.start(ctx.workspace, job.id, false)).rejects.toThrow(/主动/);
  await ctx.runtime.start(ctx.workspace, job.id, true, config);
  await ctx.runtime.waitForIdle();
  const completed = await ctx.runtime.read(ctx.workspace, job.id);
  expect(completed.status).toBe('completed'); expect(completed.blocks.every(b => b.translation)).toBe(true);
  expect(JSON.stringify(await readTranslationJob(ctx.workspace, job.id))).not.toContain('secret-fixture-key');
});
it('retains completed chunks across failure and restart, then resumes only remaining source', async () => {
  let calls = 0;
  const ctx = await setup({ translate: async (_config, _key, blocks) => {
    if (++calls === 2) throw new AppError('模型服务暂不可用，请稍后继续');
    return blocks.map(b => ({ id: b.id, translation: `中文${b.id}`, warnings: [] }));
  } });
  await ctx.runtime.saveSettings(ctx.workspace, { ...config, apiKey: 'fixture' });
  const job = await ctx.runtime.create(ctx.workspace, ctx);
  await ctx.runtime.start(ctx.workspace, job.id, true, config); await ctx.runtime.waitForIdle();
  const failed = await ctx.runtime.read(ctx.workspace, job.id);
  expect(failed.status).toBe('failed'); expect(failed.blocks.filter(b => b.translation)).toHaveLength(2);
  await ctx.runtime.stop();
  const requested: string[] = [];
  const next = new TranslationRuntime({ translate: async (_config, _key, blocks) => { requested.push(...blocks.map(b => b.id)); return blocks.map(b => ({ id: b.id, translation: `继续${b.id}`, warnings: [] })); } }); runtimes.push(next);
  expect((await next.settings(ctx.workspace)).hasApiKey).toBe(false);
  await next.saveSettings(ctx.workspace, { ...config, apiKey: 'fixture' });
  await next.start(ctx.workspace, job.id, true, config); await next.waitForIdle();
  expect(requested).toEqual(['p3']); expect((await next.read(ctx.workspace, job.id)).status).toBe('completed');
});
it('pauses in-flight work, keeps local CRUD available, and discards a response after abort', async () => {
  let began!: () => void, complete!: () => void;
  const started = new Promise<void>(r => { began = r; });
  const wait = new Promise<void>(r => { complete = r; });
  const ctx = await setup({ translate: async (_config, _key, blocks) => { began(); await wait; return blocks.map(b => ({ id: b.id, translation: '过期响应', warnings: [] })); } });
  await ctx.runtime.saveSettings(ctx.workspace, { ...config, apiKey: 'fixture' });
  const job = await ctx.runtime.create(ctx.workspace, ctx);
  await ctx.runtime.start(ctx.workspace, job.id, true, config); await started;
  expect((await ctx.workspace.save({ type: 'task', title: '翻译中仍可保存待办' })).entity.title).toContain('待办');
  const pausing = ctx.runtime.pause(ctx.workspace, job.id); complete(); await pausing;
  const paused = await ctx.runtime.read(ctx.workspace, job.id);
  expect(paused.status).toBe('paused'); expect(paused.blocks.every(b => !b.translation)).toBe(true);
});
it('does not carry a key to a changed endpoint or disclose unexpected provider errors', async () => {
  const ctx = await setup({ translate: async () => { throw new Error('Authorization: secret-fixture-key'); } });
  await ctx.runtime.saveSettings(ctx.workspace, { ...config, apiKey: 'secret-fixture-key' });
  expect((await ctx.runtime.saveSettings(ctx.workspace, { ...config, baseUrl: 'https://other.example/v1' })).hasApiKey).toBe(false);
  await ctx.runtime.saveSettings(ctx.workspace, { ...config, apiKey: 'secret-fixture-key' });
  const job = await ctx.runtime.create(ctx.workspace, ctx);
  await ctx.runtime.start(ctx.workspace, job.id, true, config); await ctx.runtime.waitForIdle();
  expect((await ctx.runtime.read(ctx.workspace, job.id)).error).not.toContain('secret-fixture-key');
});
it('treats an interrupted persisted task as paused without starting a network request', async () => {
  const ctx = await setup();
  const job = await ctx.runtime.create(ctx.workspace, ctx);
  await saveTranslationJob(ctx.workspace, { ...job, status: 'running', config });
  expect((await ctx.runtime.read(ctx.workspace, job.id)).status).toBe('paused');
  const reader = await Workspace.open(ctx.workspace.root); workspaces.push(reader);
  expect((await ctx.runtime.list(reader))[0].status).toBe('paused');
  await expect(ctx.runtime.start(reader, job.id, true)).rejects.toThrow(/只读/);
});
it('does not recreate a deleted paper when a model response arrives late', async () => {
  let began!: () => void, complete!: () => void;
  const started = new Promise<void>(r => { began = r; });
  const wait = new Promise<void>(r => { complete = r; });
  const ctx = await setup({ translate: async (_config, _key, blocks) => { began(); await wait; return blocks.map(b => ({ id: b.id, translation: '迟到的响应', warnings: [] })); } });
  await ctx.runtime.saveSettings(ctx.workspace, { ...config, apiKey: 'fixture' });
  const job = await ctx.runtime.create(ctx.workspace, ctx);
  await ctx.runtime.start(ctx.workspace, job.id, true, config); await started;
  const paper = await ctx.workspace.get(ctx.paperId);
  await ctx.workspace.remove(paper.id, paper.revision);
  const unrelated = await ctx.workspace.save({ type: 'task', title: '仍然可以删除的待办' });
  let unrelatedError: unknown;
  try { await ctx.runtime.stopForPaper(ctx.workspace, unrelated.entity.id); await ctx.workspace.remove(unrelated.entity.id, unrelated.entity.revision); }
  catch (error) { unrelatedError = error; }
  complete(); await ctx.runtime.waitForIdle();
  expect(unrelatedError).toBeUndefined();
  expect(await ctx.runtime.list(ctx.workspace)).toEqual([]);
  await expect(fs.access(path.join(ctx.workspace.root, 'papers', paper.id))).rejects.toThrow();
});
it('freezes model and glossary per task while later tasks use newly saved settings', async () => {
  let release!: () => void, began!: () => void;
  const wait = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { began = r; });
  const used: string[] = [];
  const ctx = await setup({ translate: async (cfg, _key, blocks) => { used.push(`${cfg.model}:${cfg.glossary[0].target}`); began(); await wait; return blocks.map(b => ({ id: b.id, translation: '中文', warnings: [] })); } });
  await ctx.runtime.saveSettings(ctx.workspace, { ...config, apiKey: 'fixture' });
  const job = await ctx.runtime.create(ctx.workspace, ctx);
  await ctx.runtime.start(ctx.workspace, job.id, true, config); await started;
  await ctx.runtime.saveSettings(ctx.workspace, { ...config, model: 'new-model', glossary: [{ source: 'sample', target: '试样' }] });
  await expect(ctx.runtime.start(ctx.workspace, job.id, true, config)).rejects.toThrow(/已有/);
  release(); await ctx.runtime.waitForIdle();
  expect(used).toEqual(['fixture-model:样本', 'fixture-model:样本']);
});
it('translates papers with many short captions without exceeding the provider segment limit', async () => {
  const ctx = await setup({
    extract: async () => ({ pageCount: 1, warnings: [], blocks: Array.from({ length: 201 }, (_, n) => ({ id: `caption${n}`, page: 1, source: `Fig ${n}`, warnings: [] })) }),
    translate: async (_config, _key, blocks) => {
      if (blocks.length > 100) throw new AppError('单批最多 100 段');
      return blocks.map(block => ({ id: block.id, translation: '图', warnings: [] }));
    },
  });
  await ctx.runtime.saveSettings(ctx.workspace, { ...config, apiKey: 'fixture' });
  const job = await ctx.runtime.create(ctx.workspace, ctx);
  await ctx.runtime.start(ctx.workspace, job.id, true, config); await ctx.runtime.waitForIdle();
  expect((await ctx.runtime.read(ctx.workspace, job.id)).status).toBe('completed');
});
it('rejects stale confirmation when another window has changed the destination before start', async () => {
  let calls = 0;
  const ctx = await setup({ translate: async (_config, _key, blocks) => { calls++; return blocks.map(b => ({ id: b.id, translation: '中文', warnings: [] })); } });
  await ctx.runtime.saveSettings(ctx.workspace, { ...config, apiKey: 'fixture-a' });
  const job = await ctx.runtime.create(ctx.workspace, ctx);
  await ctx.runtime.saveSettings(ctx.workspace, { ...config, baseUrl: 'https://other.example/v1', apiKey: 'fixture-b' });
  await expect(ctx.runtime.start(ctx.workspace, job.id, true, config)).rejects.toMatchObject({ status: 409 });
  expect(calls).toBe(0); expect((await ctx.runtime.read(ctx.workspace, job.id)).status).toBe('ready');
});
it('opens settings without probing the operating-system keychain when no key has ever been saved', async () => {
  let probes = 0;
  const ctx = await setup({
    credentials: { get: async () => null, set: async () => {}, delete: async () => {} },
    credentialsAvailable: () => { probes++; throw new Error('Operating-system unlock is pending'); },
  });
  expect((await ctx.runtime.settings(ctx.workspace)).hasApiKey).toBe(false);
  expect((await ctx.runtime.saveSettings(ctx.workspace, config)).hasApiKey).toBe(false);
  expect(probes).toBe(0);
});
it('keeps settings and credential clearing available when an existing key cannot be decrypted', async () => {
  let stored = true, requests = 0;
  const ctx = await setup({
    credentials: {
      get: async () => { if (stored) throw new Error('cipher failure with secret-fixture-key'); return null; },
      set: async () => {}, delete: async () => { stored = false; },
    },
    credentialsAvailable: () => false,
    test: async () => { requests++; },
    translate: async () => { requests++; return []; },
  });
  const settings = await ctx.runtime.settings(ctx.workspace);
  expect(settings).toMatchObject({ hasApiKey: false, keyStorage: 'encrypted' });
  expect(settings.keyError).toMatch(/密钥.*清除/);
  expect(JSON.stringify(settings)).not.toContain('secret-fixture-key');
  await expect(ctx.runtime.test(ctx.workspace)).rejects.toThrow(settings.keyError);
  const job = await ctx.runtime.create(ctx.workspace, ctx);
  await expect(ctx.runtime.start(ctx.workspace, job.id, true, settings)).rejects.toThrow(settings.keyError);
  expect(requests).toBe(0);
  const cleared = await ctx.runtime.saveSettings(ctx.workspace, { ...settings, clearApiKey: true });
  expect(cleared.hasApiKey).toBe(false); expect(cleared.keyError).toBeUndefined(); expect(stored).toBe(false);
});
