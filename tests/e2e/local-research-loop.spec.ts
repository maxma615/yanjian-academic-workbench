import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { samplePdf } from '../helpers/sample-pdf';
import { verifyBackup } from '../../src/backup/backup-service';

let server: ChildProcess, root: string, url: string;
async function launch(control = 'control') {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', '--production'], { cwd: process.cwd(), env: { ...process.env, ACADEMIC_PORT: '0', ACADEMIC_DATA_DIR: path.join(root, 'workspace'), ACADEMIC_CONTROL_DIR: path.join(root, control) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const address = await new Promise<string>((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error(`Server failed to start: ${output}`)), 20000);
    child.stdout!.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.stderr!.on('data', chunk => { output += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
  return { child, address };
}
async function start() { const launched = await launch(); server = launched.child; url = launched.address; }
async function stop(child = server) { if (!child || child.exitCode !== null) return; await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM'); }); }
test.beforeEach(async ({ page }) => {
  await fs.mkdir('.test-data', { recursive: true }); root = await fs.mkdtemp(path.resolve('.test-data/browser-')); await start();
  await page.route('**/*', route => { const u = new URL(route.request().url()); if (u.protocol.startsWith('http') && u.hostname !== '127.0.0.1') return route.abort(); return route.continue(); });
  await page.goto(url); await expect(page.getByRole('heading', { name: '今天，继续向前一点。' })).toBeVisible();
});
test.afterEach(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
async function nav(page: Page, label: string) {
  if ((page.viewportSize()?.width ?? 1440) <= 680 && !await page.getByRole('navigation').isVisible()) await page.getByRole('button', { name: '展开导航', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: new RegExp(`^${label}(?:\\s|$)`) }).click();
}
async function save(page: Page) { await page.getByRole('button', { name: '保存到本地', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); }

test('offline research loop persists actual papers, PDF, linked notes, logs, tasks and events after process restart', async ({ page }) => {
  const requests: string[] = []; page.on('request', req => { if (req.url().startsWith('http') && !req.url().startsWith(url)) requests.push(req.url()); });
  await nav(page, '文献'); await page.getByRole('button', { name: '录入文献', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('离线文献验收'); await page.getByLabel('作者', { exact: true }).fill('研究者'); await save(page);
  await page.getByRole('button', { name: /离线文献验收.*研究者/ }).click();
  await page.locator('input[type=file][accept="application/pdf"]').setInputFiles({ name: '研究 样例.pdf', mimeType: 'application/pdf', buffer: samplePdf() });
  // Import may keep the updated editor open; close it after the server confirms the upload.
  await expect(page.getByText('PDF 已保存到本地', { exact: true })).toBeVisible();
  const exportedPdf = page.waitForEvent('download');
  await page.locator('.attachment-row').getByRole('button', { name: '导出', exact: true }).click();
  const exportedPath = path.join(root, 'exported.pdf'); await (await exportedPdf).saveAs(exportedPath);
  expect(await fs.readFile(exportedPath)).toEqual(samplePdf());
  if (await page.getByRole('dialog').count()) await page.getByRole('button', { name: '关闭编辑器' }).click();
  await nav(page, '笔记'); await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('方法阅读笔记'); await page.getByLabel('Markdown 内容').fill('# 消融实验\n这个结果需要复现。');
  await page.getByLabel('关联文献（可多选）').selectOption({ label: '离线文献验收' }); await save(page);
  await nav(page, '研究日志');
  for (const title of ['实验记录一', '实验记录二']) { await page.getByRole('button', { name: '记录今天', exact: true }).click(); await page.getByLabel('标题', { exact: true }).fill(title); await page.getByLabel('研究内容').fill('相同日期，不同记录'); await save(page); }
  await nav(page, '待办'); await page.getByRole('button', { name: '新增待办', exact: true }).click(); await page.getByLabel('标题', { exact: true }).fill('完成消融实验'); await save(page);
  await nav(page, '日历'); await page.getByRole('button', { name: /新增日程/ }).click(); await page.getByLabel('标题', { exact: true }).fill('组会交流'); await save(page);
  await page.getByRole('button', { name: /新增日程/ }).click(); await page.getByLabel('标题', { exact: true }).fill('跨天实验');
  await page.getByLabel('开始日期', { exact: true }).fill('2026-09-23'); await page.getByLabel('结束日期', { exact: true }).fill('2026-09-24');
  await page.getByLabel('全天', { exact: true }).uncheck(); await page.getByLabel('开始时间（上海）').fill('23:30'); await page.getByLabel('结束时间（上海）').fill('00:30'); await save(page);
  await stop(); await start(); await page.goto(url); await nav(page, '笔记'); await expect(page.getByText('方法阅读笔记', { exact: true })).toBeVisible();
  await page.getByLabel('搜索', { exact: true }).fill('消融实验'); await expect(page.getByText('方法阅读笔记', { exact: true })).toBeVisible();
  const notes = await fs.readdir(path.join(root, 'workspace/notes')); expect(notes).toHaveLength(1);
  expect(await fs.readFile(path.join(root, 'workspace/notes', notes[0]), 'utf8')).toContain('消融实验');
  const logs = await fs.readdir(path.join(root, 'workspace/logs')); expect((await fs.readdir(path.join(root, 'workspace/logs', logs[0])))).toHaveLength(2);
  expect(requests.filter(r => !/http:\/\/127\.0\.0\.1:\d+/.test(r))).toEqual([]);
  const markdown = page.waitForEvent('download'); await page.getByRole('button', { name: '导出方法阅读笔记' }).click();
  const mdPath = path.join(root, 'exported.md'); await (await markdown).saveAs(mdPath);
  expect(await fs.readFile(mdPath)).toEqual(await fs.readFile(path.join(root, 'workspace/notes', notes[0])));
  await page.getByRole('button', { name: '清除搜索' }).click(); await nav(page, '概览');
  await page.screenshot({ path: 'test-results/research-loop.png', fullPage: true });
  await nav(page, '资料与设置');
  const downloadedBackup = page.waitForEvent('download'); await page.getByRole('button', { name: '下载本地备份' }).click();
  const archivePath = path.join(root, 'full-backup.zip'); await (await downloadedBackup).saveAs(archivePath);
  const verified = verifyBackup(await fs.readFile(archivePath));
  expect([...verified.files.keys()].filter(name => name.endsWith('.pdf'))).toHaveLength(1);
  expect([...verified.files.keys()].filter(name => name.startsWith('events/'))).toHaveLength(2);
  const target = path.join(root, '全量恢复 中文'); await fs.mkdir(target);
  await page.locator('input[type=file][accept=".zip,application/zip"]').setInputFiles(archivePath);
  await page.getByLabel('目标空目录路径').fill(target); await page.getByRole('button', { name: '开始恢复' }).click();
  await expect(page.getByText(target, { exact: true })).toBeVisible();
  for (const [name, bytes] of verified.files) expect(await fs.readFile(path.join(target, name))).toEqual(Buffer.from(bytes));
  await stop(); await start(); await page.goto(url); await nav(page, '文献');
  await page.locator('.row-main').filter({ hasText: '离线文献验收' }).click();
  const restoredPdf = page.waitForEvent('download'); await page.locator('.attachment-row').getByRole('button', { name: '导出', exact: true }).click();
  const restoredPdfPath = path.join(root, 'restored.pdf'); await (await restoredPdf).saveAs(restoredPdfPath);
  expect(await fs.readFile(restoredPdfPath)).toEqual(samplePdf());
});

test('UI exports a verified backup and restores all authoritative files into a selected new directory', async ({ page }) => {
  await nav(page, '待办'); await page.getByRole('button', { name: '新增待办', exact: true }).click(); await page.getByLabel('标题', { exact: true }).fill('备份恢复验收'); await save(page);
  await nav(page, '资料与设置');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '下载本地备份' }).click();
  const archive = path.join(root, 'backup.zip'); await (await download).saveAs(archive);
  await page.locator('input[type=file][accept=".zip,application/zip"]').setInputFiles(archive);
  const target = path.join(root, '恢复 新资料'); await fs.mkdir(target);
  await page.getByLabel('目标空目录路径').fill(target); await page.getByRole('button', { name: '开始恢复' }).click();
  await expect(page.getByText(target, { exact: true })).toBeVisible();
  await nav(page, '待办'); await expect(page.getByText('备份恢复验收', { exact: true })).toBeVisible();
  const originalFiles = await fs.readdir(path.join(root, 'workspace/tasks'));
  for (const file of originalFiles) expect(await fs.readFile(path.join(target, 'tasks', file))).toEqual(await fs.readFile(path.join(root, 'workspace/tasks', file)));
  await stop(); await start(); await page.goto(url); await nav(page, '待办'); await expect(page.getByText('备份恢复验收', { exact: true })).toBeVisible();
});

test('second process is read-only but still allows full-text reading and export', async ({ page }) => {
  await nav(page, '笔记'); await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('只读笔记');
  const body = '这是很长的研究笔记。'.repeat(30) + '全文结尾可阅读';
  await page.getByLabel('Markdown 内容').fill(body); await save(page);
  const second = await launch('readonly-control');
  try {
    await page.goto(second.address); await expect(page.getByText(/当前资料目录为只读。/)).toBeVisible();
    await nav(page, '笔记'); await expect(page.getByRole('button', { name: '新建笔记', exact: true })).toBeDisabled();
    await page.locator('.row-main').filter({ hasText: '只读笔记' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText(body, { exact: true })).toBeVisible();
    const download = page.waitForEvent('download'); await page.getByRole('dialog').getByRole('button', { name: '导出', exact: true }).click();
    const output = path.join(root, 'readonly-note.md'); await (await download).saveAs(output);
    expect(await fs.readFile(output, 'utf8')).toContain(body);
    await expect(page.getByRole('button', { name: '保存到本地' })).toHaveCount(0);
  } finally { await stop(second.child); }
});

test('concurrent editing preserves unsaved input and warns instead of overwriting a newer revision', async ({ page, context }) => {
  await nav(page, '笔记'); await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('并发笔记'); await save(page);
  const other = await context.newPage(); await other.goto(url); await nav(other, '笔记');
  await page.locator('.row-main').filter({ hasText: '并发笔记' }).click();
  await other.locator('.row-main').filter({ hasText: '并发笔记' }).click();
  await page.getByLabel('Markdown 内容').fill('先保存的内容'); await save(page);
  await other.getByLabel('Markdown 内容').fill('不能丢失的未保存输入');
  await other.getByRole('button', { name: '保存到本地', exact: true }).click();
  await expect(other.locator('.form-error')).toContainText('你的输入已保留');
  await expect(other.getByLabel('Markdown 内容')).toHaveValue('不能丢失的未保存输入');
  const notes = await fs.readdir(path.join(root, 'workspace/notes'));
  expect(await fs.readFile(path.join(root, 'workspace/notes', notes[0]), 'utf8')).toContain('先保存的内容');
  await other.close();
});

test('narrow window keeps navigation, task completion, deletion preservation and index rebuild usable', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 900 });
  await nav(page, '待办'); await page.getByRole('button', { name: '新增待办', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('窄窗待办'); await save(page);
  await page.locator('.row-main').filter({ hasText: '窄窗待办' }).click();
  await page.getByLabel('已完成', { exact: true }).check(); await save(page);
  await page.locator('.segmented').getByRole('button', { name: /已完成/ }).click();
  await expect(page.getByText('窄窗待办', { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '删除窄窗待办' }).click();
  await expect(page.getByText('窄窗待办', { exact: true })).toHaveCount(0);
  expect(await fs.readdir(path.join(root, 'workspace/tombstones/task'))).toHaveLength(1);
  await nav(page, '资料与设置'); await page.getByRole('button', { name: '重建索引', exact: true }).click();
  await expect(page.getByText('索引已重建', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.locator('.card').evaluateAll(cards => cards.every(card => card.getBoundingClientRect().right <= window.innerWidth + 1))).toBe(true);
  await page.screenshot({ path: 'test-results/narrow-window.png', fullPage: true });
});
