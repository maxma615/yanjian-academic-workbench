import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../../server/app';
import { translationPdf } from '../helpers/translation-pdf';

const paperPdf = (title = 'Working Memory and Learning', authors = 'Alice Smith and Robert Jones') => translationPdf([{ lines: [
  { text: title, x: 50, y: 760, size: 22 },
  { text: authors, x: 50, y: 710, size: 12 },
  { text: 'Department of Psychology, Example University', x: 50, y: 680, size: 10 },
  { text: 'Published in 2024', x: 50, y: 650, size: 10 },
  { text: 'Abstract', x: 50, y: 610, size: 14 },
  { text: 'We investigate learning and memory in a controlled study.', x: 50, y: 580, size: 11 },
] }]);
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function closeServer(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function fixture() {
  await fs.mkdir('.test-data', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-data/pdf-import-ui-'));
  const handle = await createApp(path.join(root, 'workspace'), { controlDirectory: path.join(root, 'control') });
  handle.app.use(express.static(path.resolve('dist')));
  const server = createServer(handle.app), url = await listen(server);
  return { root, handle, url, close: async () => { await handle.close(); await closeServer(server); await fs.rm(root, { recursive: true, force: true }); } };
}
async function choose(page: Page, name = 'memory-paper.pdf', buffer = paperPdf()) {
  await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer });
}

test('starts with a PDF, suggests local metadata, reviews only essential fields and opens the saved paper', async ({ page }) => {
  const app = await fixture(); const external: string[] = [], errors: string[] = [];
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(app.url)) external.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${app.url}/#papers`);
    await page.getByRole('button', { name: '导入 PDF', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导入文献', exact: true });
    await expect(dialog.getByLabel('标题', { exact: true })).toHaveCount(0);
    await choose(page);
    await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue('Working Memory and Learning');
    await expect(dialog.getByLabel('作者', { exact: true })).toHaveValue(/Alice Smith.*Robert Jones/);
    await expect(dialog.getByLabel('年份', { exact: true })).toHaveValue('2024');
    await expect(dialog.getByLabel('DOI', { exact: true })).not.toBeVisible();
    await expect(dialog.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
    expect(await app.handle.getWorkspace().list()).toHaveLength(0);
    await page.screenshot({ path: 'test-results/pdf-import-review-desktop.png' });
    await dialog.getByLabel('作者', { exact: true }).fill('Alice Smith, Robert Jones');
    await page.getByRole('button', { name: '确认保存并阅读', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Working Memory and Learning', exact: true })).toBeVisible();
    const [paper] = await app.handle.getWorkspace().list();
    expect(paper.authors).toBe('Alice Smith, Robert Jones');
    expect(paper.attachments).toHaveLength(1);
    expect(await fs.readFile(path.join(app.root, 'workspace', paper.attachments![0].path))).toEqual(paperPdf());
    await page.reload(); await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
    expect(external).toEqual([]); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('cancel and invalid files create no paper; scans allow a filename fallback with empty unknown fields at narrow width', async ({ page }) => {
  const app = await fixture();
  try {
    await page.goto(app.url); await page.getByRole('button', { name: '添加文献', exact: true }).click();
    await choose(page); await expect(page.getByLabel('标题', { exact: true })).toHaveValue('Working Memory and Learning');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(await app.handle.getWorkspace().list()).toHaveLength(0);
    await page.getByRole('button', { name: '添加文献', exact: true }).click();
    await choose(page, 'broken.pdf', Buffer.from('not a PDF'));
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await app.handle.getWorkspace().list()).toHaveLength(0);
    await page.setViewportSize({ width: 390, height: 980 });
    await choose(page, 'scanned-paper.pdf', translationPdf([{ image: true }]));
    await expect(page.getByLabel('标题', { exact: true })).toHaveValue('scanned paper');
    await expect(page.getByLabel('作者', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('年份', { exact: true })).toHaveValue('');
    await expect(page.getByText('使用文件名，待核对', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
    await expect(page.getByRole('button', { name: '确认保存并阅读', exact: true })).toBeEnabled();
    await page.screenshot({ path: 'test-results/pdf-import-review-narrow.png', fullPage: false });
    await page.getByRole('button', { name: '确认保存并阅读', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'scanned paper', exact: true })).toBeVisible();
    const papers = await app.handle.getWorkspace().list(); expect(papers).toHaveLength(1); expect(papers[0].authors || '').toBe('');
  } finally { await app.close(); }
});

test('replacing the selected PDF discards late metadata from the previous file', async ({ page }) => {
  const app = await fixture(); let release!: () => void, requested!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), seen = new Promise<void>(resolve => { requested = resolve; });
  let inspections = 0;
  try {
    await page.goto(`${app.url}/#papers`); await page.getByRole('button', { name: '导入 PDF', exact: true }).click();
    await page.route('**/api/papers/inspect-pdf', async route => {
      if (++inspections !== 1) return route.continue();
      const response = await route.fetch(); requested(); await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    await choose(page); await seen;
    await choose(page, 'second.pdf', paperPdf('Attention and Cognition', 'Emma Brown and David Lee'));
    await expect(page.getByLabel('标题', { exact: true })).toHaveValue('Attention and Cognition');
    release();
    await expect(page.getByLabel('作者', { exact: true })).toHaveValue(/Emma Brown.*David Lee/);
    await page.getByRole('button', { name: '确认保存并阅读', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Attention and Cognition', exact: true })).toBeVisible();
    const [paper] = await app.handle.getWorkspace().list();
    expect(await fs.readFile(path.join(app.root, 'workspace', paper.attachments![0].path))).toEqual(paperPdf('Attention and Cognition', 'Emma Brown and David Lee'));
  } finally { release(); await app.close(); }
});

test('retrying after a lost save response preserves reviewed input and does not create a second paper', async ({ page }) => {
  const app = await fixture(); let saves = 0; const requestIds: string[] = [];
  try {
    await page.goto(`${app.url}/#papers`); await page.getByRole('button', { name: '导入 PDF', exact: true }).click();
    await choose(page); await expect(page.getByLabel('标题', { exact: true })).toHaveValue('Working Memory and Learning');
    await page.getByLabel('标题', { exact: true }).fill('Reviewed paper title');
    await page.route('**/api/papers/import-pdf', async route => {
      requestIds.push(route.request().postDataJSON().requestId);
      if (++saves !== 1) return route.continue();
      await route.fetch(); await route.abort('failed');
    });
    await page.getByRole('button', { name: '确认保存并阅读', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('标题', { exact: true })).toHaveValue('Reviewed paper title');
    expect(await app.handle.getWorkspace().list()).toHaveLength(1);
    await page.getByRole('button', { name: '确认保存并阅读', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reviewed paper title', exact: true })).toBeVisible();
    expect(requestIds).toHaveLength(2); expect(requestIds[0]).toBe(requestIds[1]);
    expect(await app.handle.getWorkspace().list()).toHaveLength(1);
  } finally { await app.close(); }
});
