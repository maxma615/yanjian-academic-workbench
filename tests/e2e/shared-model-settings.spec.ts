import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../../server/app';
import { translationPdf } from '../helpers/translation-pdf';

async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

test('one model configuration identifies a PDF then translates it, preserves rules, and never displays the saved key', async ({ page }) => {
  await fs.mkdir('.test-data', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-data/shared-model-ui-'));
  const requests: { key?: string; body: any; type: string }[] = [];
  const provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), data = JSON.parse(body.messages[1].content);
    const type = data.firstPageText !== undefined ? 'metadata' : data.segments[0]?.id === 'connection-test' ? 'test' : 'translation';
    requests.push({ key: request.headers.authorization, body, type });
    const result = type === 'metadata' ? {
      title: { value: 'Working Memory and Learning', evidence: 'Working Memory and Learning' },
      authors: { value: ['Alice Smith', 'Robert Jones'], evidence: 'Alice Smith and Robert Jones' },
      year: { value: 2024, evidence: 'Published in 2024' }, publication: null, doi: null, url: null,
    } : { segments: data.segments.map((segment: { id: string; source: string }) => ({ id: segment.id, translation: `工作记忆与学习的中文译文。 ${(segment.source.match(/⟦[^⟧]+⟧|\d+(?:\.\d+)?/gu) || []).join(' ')}` })) };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
  });
  const providerUrl = `${await listen(provider)}/v1`;
  const handle = await createApp(path.join(root, 'workspace'), { controlDirectory: path.join(root, 'control') });
  const rules = { glossary: [{ source: 'working memory', target: '工作记忆' }], instructions: '保留作者的不确定表达。' };
  await handle.getWorkspace().exclusive(() => handle.getWorkspace().syncWriteAtomically('state/translation-settings.json', JSON.stringify({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', ...rules })));
  handle.app.use(express.static(path.resolve('dist')));
  const server = createServer(handle.app), url = await listen(server);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${url}/#settings`);
    const panel = page.getByRole('region', { name: '在线模型', exact: true });
    await panel.getByLabel('Base URL（API 地址）', { exact: true }).fill(providerUrl);
    await panel.getByLabel('模型名称', { exact: true }).fill('shared-fixture-model');
    await panel.getByLabel('API Key（密钥）', { exact: true }).fill('shared-e2e-secret');
    await panel.getByRole('button', { name: '保存模型设置', exact: true }).click();
    await expect(panel.getByText('模型设置已保存，文献识别与全文翻译共用此配置。', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('API Key（密钥）', { exact: true })).toHaveValue('');
    await expect(panel.getByLabel('API Key（密钥）', { exact: true })).toHaveAttribute('type', 'password');
    const stored = JSON.parse(await fs.readFile(path.join(root, 'workspace/state/translation-settings.json'), 'utf8'));
    expect(stored).toMatchObject(rules); expect(JSON.stringify(stored)).not.toContain('shared-e2e-secret');
    await panel.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(panel.getByText('连接测试通过，可以识别文献信息和翻译。', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/shared-model-settings-desktop.png', fullPage: false });
    await page.setViewportSize({ width: 390, height: 980 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.goto(`${url}/#papers`);
    await page.getByRole('button', { name: '导入 PDF', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导入文献', exact: true });
    await expect(dialog.getByText('shared-fixture-model', { exact: true })).toBeVisible();
    const pdf = translationPdf([{ lines: [
      { text: 'Working Memory and Learning', x: 50, y: 760, size: 22 },
      { text: 'Alice Smith and Robert Jones', x: 50, y: 710, size: 12 },
      { text: 'Published in 2024', x: 50, y: 680, size: 10 },
      { text: 'Abstract', x: 50, y: 630, size: 14 },
      { text: 'We investigate working memory and learning in a controlled study.', x: 50, y: 600, size: 11 },
    ] }]);
    await dialog.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles({ name: 'research.pdf', mimeType: 'application/pdf', buffer: pdf });
    await expect(dialog.getByText('已使用 shared-fixture-model 识别，请对照原文确认。', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('作者', { exact: true })).toHaveValue('Alice Smith, Robert Jones');
    expect(await handle.getWorkspace().list()).toHaveLength(0);
    await dialog.getByRole('button', { name: '确认保存并阅读', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Working Memory and Learning', exact: true })).toBeVisible();
    await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
    await page.getByRole('button', { name: '全文翻译', exact: true }).click();
    const translation = page.getByRole('complementary', { name: '当前文献翻译', exact: true });
    await translation.getByRole('checkbox').check();
    await translation.getByRole('button', { name: '开始全文翻译', exact: true }).click();
    await expect(page.locator('.translation-target').first()).toContainText('中文译文');
    expect(requests.map(request => request.type)).toEqual(['test', 'metadata', 'translation']);
    expect(requests.every(request => request.key === 'Bearer shared-e2e-secret' && request.body.model === 'shared-fixture-model')).toBe(true);
    expect(JSON.stringify(requests[1].body)).toContain('firstPageText');
    expect(JSON.stringify(requests[2].body)).toContain('工作记忆');
    expect(await page.locator('body').innerText()).not.toContain('shared-e2e-secret');
    const [paper] = await handle.getWorkspace().list();
    expect(paper.authors).toBe('Alice Smith, Robert Jones'); expect(paper.attachments).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally { await handle.close(); await close(server); await close(provider); await fs.rm(root, { recursive: true, force: true }); }
});
