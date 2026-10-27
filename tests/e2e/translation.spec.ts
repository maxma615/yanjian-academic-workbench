import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import { createServer, type Server, type ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../../server/app';
import type { TranslationRuntimeOptions } from '../../server/translation-runtime';
import { translationPdf } from '../helpers/translation-pdf';
import type { TranslationJob } from '../../src/shared/translation';

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function closeServer(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function translationTools(page: Page) {
  if (!await page.getByRole('complementary', { name: '当前文献翻译' }).isVisible()) await page.getByRole('button', { name: '全文翻译', exact: true }).click();
}
async function configure(page: Page, baseUrl: string) {
  const readerUrl = page.url();
  await page.goto(`${new URL(readerUrl).origin}/#settings`);
  await page.getByLabel('Base URL（API 地址）', { exact: true }).fill(baseUrl);
  await page.getByLabel('模型名称', { exact: true }).fill('local-fixture-model');
  await page.getByLabel('API Key（密钥）', { exact: true }).fill('e2e-translation-secret');
  await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
  await expect(page.getByText('模型设置已保存，文献识别与全文翻译共用此配置。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('API Key（密钥）', { exact: true })).toHaveValue('');
  if (!baseUrl.includes(':9/')) {
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.getByText('连接测试通过，可以识别文献信息和翻译。', { exact: true })).toBeVisible();
  }
  await page.goto(readerUrl); await translationTools(page);
  await page.getByRole('button', { name: '翻译设置', exact: true }).click();
  await page.getByLabel('术语表（每行一个：英文术语 = 中文译法）').fill('working memory = 工作记忆');
  await page.getByLabel('额外翻译要求').fill('保留研究中的不确定性。');
  await page.getByRole('button', { name: '保存翻译设置', exact: true }).click();
  await expect(page.getByText('翻译设置已保存。', { exact: true })).toBeVisible();
}
async function fixture(pdf?: Buffer, translation?: TranslationRuntimeOptions) {
  await fs.mkdir('.test-data', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-data/translation-ui-'));
  const requests: Array<{ ids: string[]; authorization?: string; body: any }> = [];
  let behavior: 'normal' | 'hold-second' | 'fail-next' = 'normal';
  const held: ServerResponse[] = [];
  const provider = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text), segments = JSON.parse(body.messages[1].content).segments as Array<{ id: string; source: string }>;
    const isTest = segments[0]?.id === 'connection-test';
    if (!isTest) requests.push({ ids: segments.map(segment => segment.id), authorization: request.headers.authorization, body });
    if (!isTest && behavior === 'fail-next') { behavior = 'normal'; response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'simulated outage' })); return; }
    if (!isTest && behavior === 'hold-second' && requests.length > 1) { held.push(response); return; }
    const translated = segments.map(segment => ({ id: segment.id, translation: `${'这是一段用于流程验收的模拟中文译文，研究结果仍需进一步核对。'.repeat(Math.max(1, Math.ceil(segment.source.length / 100)))} ${(segment.source.match(/⟦[^⟧]+⟧|\d+(?:\.\d+)?/gu) || []).join(' ')}` }));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ segments: translated }) } }] }));
  });
  const providerUrl = `${await listen(provider)}/v1`;
  const handle = await createApp(path.join(root, 'workspace'), { controlDirectory: path.join(root, 'control'), translation });
  const paper = await handle.getWorkspace().save({ type: 'paper', title: 'Working memory and learning', authors: 'Fixture Researcher' });
  if (pdf) await handle.getWorkspace().importPdf(paper.entity.id, 'working-memory.pdf', pdf, paper.entity.revision);
  handle.app.use(express.static(path.resolve('dist')));
  const server = createServer(handle.app), url = await listen(server);
  const readJob = async () => {
    const directory = path.join(root, 'workspace', 'papers', paper.entity.id, 'translations');
    const files = await fs.readdir(directory);
    return JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8')) as TranslationJob;
  };
  return { root, url, readerUrl: `${url}/#papers/${paper.entity.id}`, paperId: paper.entity.id, providerUrl, requests, handle, readJob, setBehavior: (value: typeof behavior) => { behavior = value; }, close: async () => {
    await handle.close(); held.forEach(response => response.destroy()); await closeServer(server); await closeServer(provider); await fs.rm(root, { recursive: true, force: true });
  } };
}

test('real PDF translation saves partial progress, pauses, resumes without retranslating, exports and reads offline at desktop and narrow sizes', async ({ page }) => {
  const paragraph = 'The study examines working memory and learning. The result remains uncertain and warrants further research.';
  const pdf = translationPdf(Array.from({ length: 3 }, () => ({ lines: Array.from({ length: 55 }, (_, index) => ({ text: paragraph, x: 40, y: 800 - index * 13, size: 8 })) })));
  const app = await fixture(pdf); app.setBehavior('hold-second');
  try {
    await page.goto(app.readerUrl);
    await expect(page.getByRole('heading', { name: 'Working memory and learning', exact: true })).toBeVisible();
    await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
    // External viewing still gives the original bytes; normal reading stays in the app.
    const original = page.waitForEvent('popup').then(async popup => ({ popup, download: await popup.waitForEvent('download') }));
    await page.getByRole('button', { name: '在外部打开 PDF', exact: true }).click();
    const { popup, download: sourceDownload } = await original;
    const sourcePath = path.join(app.root, 'opened-source.pdf'); await sourceDownload.saveAs(sourcePath);
    expect(await fs.readFile(sourcePath)).toEqual(pdf); await popup.close();
    await translationTools(page);
    await expect(page.getByText('尚未配置 API 密钥。你仍可提取和阅读原文。', { exact: true })).toBeVisible();
    await expect(page.locator('.translation-source').first()).toBeVisible(); expect(app.requests).toHaveLength(0);
    await expect(page.getByRole('button', { name: '开始全文翻译', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '仅译文', exact: true }).click();
    await page.getByRole('button', { name: '阅读原文 / 开启翻译', exact: true }).first().click();
    await expect(page.locator('.translation-source').first()).toBeVisible();
    await configure(page, app.providerUrl);
    expect(app.requests).toHaveLength(0);
    await expect(page.getByRole('button', { name: '开始全文翻译', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '开始全文翻译', exact: true }).click();
    await expect.poll(() => app.requests.length).toBe(2);
    await expect.poll(async () => (await app.readJob()).blocks.filter(block => block.translation).length).toBeGreaterThan(0);
    await page.getByRole('button', { name: '暂停翻译', exact: true }).click();
    await expect(page.getByRole('button', { name: '继续翻译', exact: true })).toBeVisible();
    const paused = await app.readJob(), doneIds = paused.blocks.filter(block => block.translation).map(block => block.id);
    expect(paused.status).toBe('paused'); expect(doneIds.length).toBeGreaterThan(0); expect(doneIds.length).toBeLessThan(paused.blocks.length);
    const countBeforeResume = app.requests.length; app.setBehavior('normal');
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '继续翻译', exact: true }).click();
    await expect(page.getByRole('progressbar', { name: '当前文献翻译进度', exact: true })).toHaveAttribute('value', '100', { timeout: 15000 });
    expect(app.requests.slice(countBeforeResume).flatMap(request => request.ids).every(id => !doneIds.includes(id))).toBe(true);
    expect(app.requests.every(request => request.authorization === 'Bearer e2e-translation-secret')).toBe(true);
    expect(JSON.stringify(app.requests[0].body)).toContain('工作记忆');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.getByRole('region', { name: '第 2 页阅读稿', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '原版 PDF', exact: true }).click();
    await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-page', '2');
    await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
    await page.getByRole('button', { name: '文本阅读', exact: true }).click();
    await expect(page.getByLabel('阅读页码', { exact: true })).toHaveValue('2');
    await page.getByRole('button', { name: '仅译文', exact: true }).click(); await expect(page.locator('.translation-source')).toHaveCount(0);
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
    const target = path.join(app.root, 'export.md'); await (await download).saveAs(target);
    const exported = await fs.readFile(target, 'utf8');
    expect(exported).toContain('Working memory and learning'); expect(exported).toContain('模拟中文译文'); expect(exported).toContain('The study examines');
    expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain('e2e-translation-secret');
    const callsBeforeReload = app.requests.length;
    await page.reload(); await translationTools(page);
    await expect(page.getByRole('progressbar', { name: '当前文献翻译进度', exact: true })).toHaveAttribute('value', '100');
    expect(app.requests.length).toBe(callsBeforeReload);
    expect(await fs.readdir(path.join(app.root, 'workspace', 'papers', app.paperId, 'translations'))).toHaveLength(1);
    for (const width of [1440, 960, 390]) {
      await page.setViewportSize({ width, height: 980 });
      await expect(page.locator('.translation-target').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/reader-translation-${width}.png`, fullPage: false });
      await page.getByRole('button', { name: '收起翻译工具', exact: true }).click();
      await page.locator('.reader-pagebar').evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: `test-results/reader-bilingual-${width}.png`, fullPage: false });
      await page.getByLabel('阅读字号', { exact: true }).selectOption('20');
      await expect(page.locator('.translation-target').first()).toHaveCSS('font-size', '20px');
      await page.getByLabel('阅读字号', { exact: true }).selectOption('16');
      await page.evaluate(() => window.scrollTo(0, 0)); await translationTools(page);
    }
    expect(app.requests.length).toBe(callsBeforeReload);
  } finally { await app.close(); }
});

test('provider failure keeps source readable and offers an explicit retry; changing the endpoint does not authorize the old endpoint', async ({ page }) => {
  const app = await fixture(translationPdf());
  try {
    await page.goto(app.readerUrl); await configure(page, app.providerUrl);
    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    await expect(page.locator('.translation-source').first()).toContainText('Introduction');
    app.setBehavior('fail-next');
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '开始全文翻译', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试未完成段落', exact: true })).toBeVisible();
    await expect(page.locator('.translation-source').first()).toContainText('Introduction'); expect((await app.readJob()).status).toBe('failed');
    await configure(page, 'http://127.0.0.1:9/v1');
    await expect(page.getByText(/此译本沿用/)).toBeVisible();
    await expect(page.getByRole('button', { name: '重试未完成段落', exact: true })).toBeDisabled(); expect(app.requests).toHaveLength(1);
    await configure(page, app.providerUrl);
    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '重试未完成段落', exact: true }).click();
    await expect(page.getByRole('progressbar', { name: '当前文献翻译进度', exact: true })).toHaveAttribute('value', '100');
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: 'test-results/paper-reader-bilingual.png' });
    await page.getByRole('button', { name: '收起翻译工具', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 980 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: 'test-results/paper-reader-narrow.png' });
  } finally { await app.close(); }
});

test('changing the destination in another window invalidates a previously checked translation authorization', async ({ page, context }) => {
  const app = await fixture(translationPdf()), other = await context.newPage();
  try {
    await page.goto(app.readerUrl); await configure(page, app.providerUrl);
    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    await expect(page.locator('.translation-source').first()).toContainText('Introduction');
    await page.getByRole('checkbox').check(); await expect(page.getByRole('button', { name: '开始全文翻译', exact: true })).toBeEnabled();
    await other.goto(app.readerUrl); await configure(other, 'http://127.0.0.1:9/v1');
    const startResponse = page.waitForResponse(response => response.url().endsWith('/start') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '开始全文翻译', exact: true }).click(); expect((await startResponse).status()).toBe(409);
    await expect(page.locator('.translation-feedback.error')).toBeVisible(); expect(app.requests).toHaveLength(0); expect((await app.readJob()).status).toBe('ready');
    await expect(page.getByRole('checkbox')).not.toBeChecked();
    await page.getByRole('button', { name: '重新载入', exact: true }).click();
    await expect(page.getByRole('checkbox')).not.toBeChecked(); await expect(page.getByRole('button', { name: '开始全文翻译', exact: true })).toBeDisabled();
    await expect(page.locator('.translation-consent')).toContainText('http://127.0.0.1:9/v1'); expect(app.requests).toHaveLength(0);
  } finally { await other.close(); await app.close(); }
});

test('missing PDF and a second read-only instance explain unavailable writes while existing source and exports remain usable', async ({ page, browser }) => {
  const app = await fixture(); let reader: Awaited<ReturnType<typeof createApp>> | undefined, readerServer: Server | undefined;
  try {
    await page.goto(app.readerUrl); await expect(page.getByRole('heading', { name: '还没有 PDF 附件', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '文本阅读', exact: true }).click(); await expect(page.getByRole('button', { name: '提取原文', exact: true })).toBeDisabled();
    const paper = (await app.handle.getWorkspace().list())[0];
    await app.handle.getWorkspace().importPdf(paper.id, 'source.pdf', translationPdf([{ lines: [{ text: 'Readable source remains offline.', x: 50, y: 730 }] }, { image: true }]), paper.revision);
    await page.reload(); await page.getByRole('button', { name: '文本阅读', exact: true }).click();
    await expect(page.locator('.translation-source').first()).toContainText('Readable source remains offline.');
    await page.locator('.translation-warnings summary').click(); await expect(page.locator('.translation-warnings')).toContainText('OCR');
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(page.getByText('这一页没有提取到可读文字。')).toBeVisible();
    await page.getByRole('button', { name: '查看这一页的原版 PDF', exact: true }).click();
    await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-page', '2'); await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
    reader = await createApp(path.join(app.root, 'workspace'), { controlDirectory: path.join(app.root, 'reader-control') });
    reader.app.use(express.static(path.resolve('dist'))); readerServer = createServer(reader.app);
    const context = await browser.newContext(), readonlyPage = await context.newPage();
    try {
      await readonlyPage.goto(`${await listen(readerServer)}/#papers/${paper.id}`);
      await expect(readonlyPage.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
      await expect(readonlyPage.getByText('当前为只读模式，可以阅读原 PDF 和已有译文、导出资料；创建译本和翻译已停用。', { exact: true })).toBeVisible();
      await translationTools(readonlyPage); await expect(readonlyPage.locator('.translation-source').first()).toContainText('Readable source remains offline.');
      await expect(readonlyPage.getByRole('button', { name: '开始全文翻译', exact: true })).toHaveCount(0);
      await readonlyPage.getByRole('button', { name: '翻译设置', exact: true }).click();
      await expect(readonlyPage.getByRole('button', { name: '保存翻译设置', exact: true })).toBeDisabled();
      const download = readonlyPage.waitForEvent('download'); await readonlyPage.getByRole('button', { name: '导出 Markdown', exact: true }).click();
      expect((await download).suggestedFilename()).toContain('双语翻译'); expect(app.requests).toHaveLength(0);
    } finally { await context.close(); }
  } finally { if (reader) await reader.close(); if (readerServer) await closeServer(readerServer); await app.close(); }
});

test('an unreadable stored key never blocks PDF reading and can be cleared from shared model settings', async ({ page }) => {
  const secret = 'CORRUPT-KEY-MUST-NOT-LEAK'; let broken = true, deletions = 0, credentialReads = 0;
  const app = await fixture(translationPdf(), { credentials: {
    get: async () => { credentialReads++; if (broken) throw new Error(`Unable to decrypt ${secret}`); return null; },
    set: async () => { broken = false; }, delete: async () => { broken = false; deletions++; },
  } });
  try {
    await page.goto(app.readerUrl); await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true'); expect(credentialReads).toBe(0);
    const loaded = page.waitForResponse(response => response.url().endsWith('/api/translation/settings') && response.request().method() === 'GET');
    await translationTools(page); const response = await loaded; expect(response.status()).toBe(200);
    const settings = await response.json(); expect(settings.hasApiKey).toBe(false); expect(JSON.stringify(settings)).not.toContain(secret);
    await expect(page.getByText(settings.keyError, { exact: true })).toBeVisible();
    const readsBeforeRetry = credentialReads; await page.getByRole('button', { name: '重新载入密钥', exact: true }).click();
    await expect.poll(() => credentialReads).toBeGreaterThan(readsBeforeRetry);
    await expect(page.getByRole('button', { name: '开始全文翻译', exact: true })).toBeDisabled();
    await page.goto(`${app.url}/#settings`);
    await expect(page.getByLabel('Base URL（API 地址）', { exact: true })).toHaveValue(settings.baseUrl);
    await expect(page.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled(); await expect(page.locator('body')).not.toContainText(secret);
    await page.getByRole('button', { name: '清除密钥', exact: true }).click();
    await expect(page.getByText('密钥已清除。文献和已保存译文仍可在本地阅读。', { exact: true })).toBeVisible(); expect(deletions).toBe(1);
    await expect(page.getByText(settings.keyError, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '清除密钥', exact: true })).toHaveCount(0);
    await page.goto(app.readerUrl); await translationTools(page);
    await expect(page.getByText('尚未配置 API 密钥。你仍可提取和阅读原文。', { exact: true })).toBeVisible(); expect(app.requests).toHaveLength(0);
  } finally { await app.close(); }
});

test('opens a paper as an offline reader and keeps translation inside that paper', async ({ page }) => {
  const app = await fixture(translationPdf()); const errors: string[] = [], external: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(app.url)) external.push(request.url()); });
  try {
    await page.goto(app.readerUrl);
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '文献翻译', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Working memory and learning', exact: true })).toBeVisible();
    await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.screenshot({ path: 'test-results/paper-reader-pdf.png' });
    expect(await page.getByTestId('pdf-page-canvas').evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 150 && pixels[i + 3] > 0) dark++; return dark;
    })).toBeGreaterThan(20);
    expect(app.requests).toHaveLength(0);
    await expect(fs.access(path.join(app.root, 'workspace', 'papers', app.paperId, 'translations'))).rejects.toThrow();
    await page.getByRole('button', { name: '文本阅读', exact: true }).click();
    await expect(page.locator('.translation-source').first()).toBeVisible(); expect(app.requests).toHaveLength(0);
    await translationTools(page); await expect(page.getByText('尚未配置 API 密钥。你仍可提取和阅读原文。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('选择文献', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: '返回文献库', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    await expect(page.getByLabel('API 地址', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '模型设置', exact: true })).toHaveAttribute('href', '#settings');
    expect(external).toEqual([]); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('switching papers and attachments preserves their own local reading drafts without creating duplicates', async ({ page }) => {
  const app = await fixture(translationPdf([{ lines: [{ text: 'First paper attachment alpha.', x: 50, y: 730 }] }]));
  try {
    const workspace = app.handle.getWorkspace();
    const first = await workspace.get(app.paperId);
    const imported = await workspace.importPdf(first.id, 'beta.pdf', translationPdf([{ lines: [{ text: 'First paper attachment beta.', x: 50, y: 730 }] }]), first.revision);
    const beta = imported.entity.attachments!.find(item => item.name === 'beta.pdf')!;
    const second = await workspace.save({ type: 'paper', title: 'Second paper' });
    await workspace.importPdf(second.entity.id, 'other.pdf', translationPdf([{ lines: [{ text: 'Second paper independent content.', x: 50, y: 730 }] }]), second.entity.revision);
    await page.goto(app.readerUrl); await page.getByRole('button', { name: '文本阅读', exact: true }).click();
    await expect(page.locator('.translation-source')).toContainText('First paper attachment alpha.');
    await page.getByLabel('PDF 附件', { exact: true }).selectOption(beta.id);
    await expect(page.locator('.translation-source')).toHaveCount(0);
    await page.getByRole('button', { name: '提取原文', exact: true }).click();
    await expect(page.locator('.translation-source')).toContainText('First paper attachment beta.');
    await page.getByRole('button', { name: '返回文献库', exact: true }).click();
    await page.locator('.entity-row .row-main').filter({ hasText: 'Second paper' }).click();
    await page.getByRole('button', { name: '文本阅读', exact: true }).click();
    await expect(page.locator('.translation-source')).toContainText('Second paper independent content.');
    await expect(page.locator('.translation-source')).not.toContainText('First paper');
    await page.getByRole('button', { name: '返回文献库', exact: true }).click();
    await page.locator('.entity-row .row-main').filter({ hasText: 'Working memory and learning' }).click();
    await page.getByRole('button', { name: '文本阅读', exact: true }).click();
    await expect(page.locator('.translation-source')).toContainText('First paper attachment alpha.');
    await page.getByLabel('PDF 附件', { exact: true }).selectOption(beta.id);
    await expect(page.locator('.translation-source')).toContainText('First paper attachment beta.');
    expect(await fs.readdir(path.join(app.root, 'workspace', 'papers', first.id, 'translations'))).toHaveLength(2);
    expect(await fs.readdir(path.join(app.root, 'workspace', 'papers', second.entity.id, 'translations'))).toHaveLength(1);
    expect(app.requests).toHaveLength(0);
  } finally { await app.close(); }
});

test('pausing one draft does not discard the selected draft when its read response arrives later', async ({ page }) => {
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const app = await fixture(translationPdf(), { translate: async (_config, _key, _blocks, _context, signal) => {
    begin(); return new Promise((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } });
  let releasePause!: () => void, releaseRead!: () => void, pauseResponse!: () => void, selectedRead!: () => void;
  const pauseGate = new Promise<void>(resolve => { releasePause = resolve; });
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const paused = new Promise<void>(resolve => { pauseResponse = resolve; });
  const requested = new Promise<void>(resolve => { selectedRead = resolve; });
  try {
    await page.goto(app.readerUrl); await configure(page, app.providerUrl);
    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '开始全文翻译', exact: true }).click(); await started;
    const paper = await app.handle.getWorkspace().get(app.paperId);
    const second = await page.evaluate(async ({ paperId, attachmentId }) => {
      const session = await (await fetch('/api/session')).json();
      const response = await fetch('/api/translations', { method: 'POST', headers: { 'X-Workbench-Token': session.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId, attachmentId }) });
      if (!response.ok) throw new Error('Unable to create fixture draft'); return response.json();
    }, { paperId: paper.id, attachmentId: paper.attachments![0].id });
    await expect(page.locator('.reader-versions option')).toHaveCount(2);
    await page.route(`**/api/translations/${second.id}`, async route => { selectedRead(); await readGate; await route.continue(); });
    await page.route('**/api/translations/*/pause', async route => { const response = await route.fetch(); pauseResponse(); await pauseGate; await route.fulfill({ response }); });
    await page.locator('.reader-versions summary').click();
    await page.getByRole('button', { name: '暂停翻译', exact: true }).click(); await paused;
    await page.getByRole('combobox', { name: '本地译本', exact: true }).selectOption(second.id); await requested;
    const pauseCompleted = page.waitForResponse(response => response.url().endsWith('/pause'));
    releasePause(); await pauseCompleted;
    await expect(page.getByText('已暂停，完成的段落已保存。继续时会从未完成处开始。', { exact: true })).toBeVisible();
    releaseRead();
    await expect(page.locator('.translation-source').first()).toContainText('Introduction');
    await expect(page.getByRole('combobox', { name: '本地译本', exact: true })).toHaveValue(second.id);
  } finally { releasePause(); releaseRead(); await app.close(); }
});
