import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { verifyBackup } from '../../src/backup/backup-service';
import { translationPdf } from '../helpers/translation-pdf';

const appRoot = path.resolve(process.cwd());
const bundleRoot = path.join(appRoot, '.test-data', 'desktop-playwright-bundle');
const mainBundle = path.join(bundleRoot, 'main.cjs');

async function buildDesktopBundle(): Promise<void> {
  process.env.ELECTRON_CACHE ||= path.join(appRoot, '.cache/electron');
  process.env.TMPDIR ||= path.join(appRoot, '.cache/desktop-tmp');
  await fs.mkdir(process.env.TMPDIR, { recursive: true });
  await fs.rm(bundleRoot, { recursive: true, force: true });
  await fs.mkdir(bundleRoot, { recursive: true });
  await fs.access(path.join(appRoot, 'dist/index.html'));
  // Exercise the production CJS banner and PDF.js ESM/worker/font asset layout.
  // A separate ad-hoc esbuild call previously hid missing runtime resources.
  await promisify(execFile)(process.execPath, ['scripts/build-desktop.mjs'], { cwd: appRoot });
  await fs.cp(path.join(appRoot, 'desktop-dist'), bundleRoot, { recursive: true });
}

async function launchDesktop(dataDirectory: string): Promise<ElectronApplication> {
  const electronExecutable = String((await import('electron')).default);
  return electron.launch({
    executablePath: electronExecutable,
    args: [mainBundle],
    env: { ...process.env, ACADEMIC_DESKTOP_DATA_DIR: dataDirectory, ACADEMIC_DESKTOP_DIST_DIR: path.join(appRoot, 'dist'), ELECTRON_ENABLE_SECURITY_WARNINGS: 'false' },
    timeout: 30_000,
  });
}

async function firstPage(application: ElectronApplication): Promise<Page> {
  const page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: '今天，继续向前一点。' })).toBeVisible();
  return page;
}

async function desktopApi(page: Page, route: string, method = 'GET', payload?: unknown): Promise<any> {
  return page.evaluate(async ({ route, method, payload }) => {
    const { token } = await (await fetch('/api/session')).json();
    const response = await fetch(route, { method, headers: { 'X-Workbench-Token': token, 'Content-Type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${result.error}`);
    return result;
  }, { route, method, payload });
}

type DialogPlan = { openFiles: Array<string | null>; directories: Array<string | null>; saves: Array<string | null> };

/** Mock only Electron's main-process dialog module; the production bridge and IPC stay enabled. */
async function installDialogPlan(application: ElectronApplication, plan: DialogPlan): Promise<void> {
  await application.evaluate(({ dialog }, value: DialogPlan) => {
    const openFiles = [...value.openFiles];
    const directories = [...value.directories];
    const saves = [...value.saves];
    dialog.showOpenDialog = (async (_window: unknown, options: { properties?: string[] }) => {
      const next = options.properties?.includes('openDirectory') ? directories.shift() : openFiles.shift();
      return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
    }) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () => {
      const next = saves.shift();
      return next ? { canceled: false, filePath: next } : { canceled: true, filePath: '' };
    }) as typeof dialog.showSaveDialog;
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, plan);
}

test.describe('Electron desktop shell', () => {
  let dataDirectory: string;
  let application: ElectronApplication | undefined;

  test.beforeAll(async () => {
    await buildDesktopBundle();
  });

  test.beforeEach(async () => {
    dataDirectory = await fs.mkdtemp(path.join(appRoot, '.test-data/electron-e2e-'));
  });

  test.afterEach(async () => {
    await application?.close();
    application = undefined;
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  test('loads the bundled dist window, exposes only the bridge, blocks remote requests, and persists after restart', async () => {
    application = await launchDesktop(dataDirectory);
    const page = await firstPage(application);
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    expect(await page.evaluate(() => Boolean(window.academicDesktop))).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { require?: unknown }).require)).toBeUndefined();
    expect(await page.evaluate(() => (window as unknown as { process?: unknown }).process)).toBeUndefined();

    await page.getByRole('button', { name: '新增待办' }).click();
    await page.getByRole('dialog').getByLabel('标题').fill('桌面重启验证');
    await page.getByRole('button', { name: '保存到本地' }).click();
    await expect(page.getByText('已保存到本地')).toBeVisible();
    expect(requests.every(url => url.startsWith('http://127.0.0.1:'))).toBe(true);

    await application.close();
    application = await launchDesktop(dataDirectory);
    const restarted = await firstPage(application);
    await expect(restarted.getByText('桌面重启验证')).toBeVisible();
  });

  test('keeps its disposable profile and data locations separate from the developer home', async () => {
    application = await launchDesktop(dataDirectory);
    await firstPage(application);
    await fs.stat(path.join(dataDirectory, 'workspace', 'workspace.json'));
    expect(await fs.stat(path.join(dataDirectory, '.electron-profile'))).toBeTruthy();
  });

  test('renders and extracts a real PDF through the production desktop bundle and reads its local draft after restart without network', async () => {
    const calls: string[] = [];
    const provider = createServer(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk;
      const segments = JSON.parse(JSON.parse(text).messages[1].content).segments as Array<{ id: string; source: string }>;
      calls.push(String(request.headers.authorization));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ segments: segments.map(segment => ({ id: segment.id, translation: `研究结果的中文译文。 ${(segment.source.match(/⟦[^⟧]+⟧|\d+/gu) ?? []).join(' ')}` })) }) } }] }));
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    const config = { baseUrl: endpoint, model: 'desktop-fixture', glossary: [], instructions: '' };
    try {
      application = await launchDesktop(dataDirectory);
      const page = await firstPage(application);
      const saved = await desktopApi(page, '/api/entities', 'POST', { type: 'paper', title: '桌面翻译论文' });
      const imported = await desktopApi(page, `/api/papers/${saved.entity.id}/pdf`, 'POST', { name: 'translation.pdf', base64: translationPdf().toString('base64'), expectedRevision: saved.entity.revision });
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.evaluate(id => { window.location.hash = `#papers/${id}`; }, saved.entity.id);
      await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-page', '2');
      await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
      expect(pageErrors).toEqual([]);
      const created = await desktopApi(page, '/api/translations', 'POST', { paperId: saved.entity.id, attachmentId: imported.entity.attachments[0].id });
      expect(created.pageCount).toBe(2); expect(created.blocks).toHaveLength(4);
      expect(created.blocks[3].source).toBe('The measurements do not prove causation.');
      expect(calls).toHaveLength(0);
      // Native safeStorage is deliberately not invoked here. On this Mac its
      // real Keychain access blocked in SecurityServer; that platform check is
      // recorded as NOT PASSED, not replaced with a plaintext/mock credential.
      const settings = await desktopApi(page, '/api/translation/settings', 'PUT', config);
      expect(settings.hasApiKey).toBe(false);
      const persisted = await fs.readFile(path.join(dataDirectory, 'workspace', 'papers', saved.entity.id, 'translations', `${created.id}.json`), 'utf8');
      expect(JSON.parse(persisted).blocks).toEqual(created.blocks);
      expect(JSON.parse(persisted).status).toBe('ready');
      await application.close();
      application = await launchDesktop(dataDirectory);
      const restarted = await firstPage(application);
      expect((await desktopApi(restarted, '/api/translation/settings')).hasApiKey).toBe(false);
      const restored = await desktopApi(restarted, `/api/translations/${created.id}`);
      expect(restored.blocks).toEqual(created.blocks); expect(restored.status).toBe('ready');
      await restarted.evaluate(id => { window.location.hash = `#papers/${id}`; }, saved.entity.id);
      await expect(restarted.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
      await restarted.getByRole('button', { name: '文本阅读', exact: true }).click();
      await expect(restarted.locator('.translation-source').first()).toContainText('Introduction');
      expect(await fs.readdir(path.join(dataDirectory, 'workspace', 'papers', saved.entity.id, 'translations'))).toHaveLength(1);
      expect(calls).toHaveLength(0);
    } finally { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
  });

  test('imports a PDF first, reviews extracted metadata and reads the same paper after desktop restart', async () => {
    application = await launchDesktop(dataDirectory);
    const page = await firstPage(application);
    const buffer = translationPdf([{ lines: [
      { text: 'Learning Through Practice', x: 50, y: 760, size: 22 },
      { text: 'Alice Smith and Robert Jones', x: 50, y: 710, size: 12 },
      { text: 'Published in 2024', x: 50, y: 680, size: 10 },
      { text: 'Abstract', x: 50, y: 630, size: 14 },
      { text: 'This study investigates how people learn.', x: 50, y: 600, size: 11 },
    ] }]);
    await page.getByRole('button', { name: '添加文献', exact: true }).click();
    await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles({ name: 'practice.pdf', mimeType: 'application/pdf', buffer });
    await expect(page.getByLabel('标题', { exact: true })).toHaveValue('Learning Through Practice');
    await expect(page.getByLabel('作者', { exact: true })).toHaveValue('Alice Smith, Robert Jones');
    await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
    expect((await desktopApi(page, '/api/state')).entities).toHaveLength(0);
    await page.getByRole('button', { name: '确认保存并阅读', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Learning Through Practice', exact: true })).toBeVisible();
    await expect(page.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
    const [paper] = (await desktopApi(page, '/api/state')).entities;
    expect(paper.attachments).toHaveLength(1);
    expect(await fs.readFile(path.join(dataDirectory, 'workspace', paper.attachments[0].path))).toEqual(buffer);
    await application.close(); application = await launchDesktop(dataDirectory);
    const restarted = await firstPage(application);
    await restarted.getByRole('button', { name: /Learning Through Practice/ }).click();
    await expect(restarted.getByTestId('pdf-page-canvas')).toHaveAttribute('data-rendered', 'true');
    expect((await desktopApi(restarted, '/api/state')).entities).toHaveLength(1);
  });

  test('drives native PDF import/export and complete backup restore through the UI', async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(appRoot, '.test-data/electron-native-ui-'));
    const sourcePdf = path.join(fixtureRoot, '输入资料.pdf');
    const exportedPdf = path.join(fixtureRoot, '导出资料.pdf');
    const backupZip = path.join(fixtureRoot, '完整备份.zip');
    const restoreTarget = path.join(fixtureRoot, '恢复后的资料');
    await fs.writeFile(sourcePdf, '%PDF-1.4\nfixture native ui\n%%EOF\n');
    await fs.mkdir(restoreTarget);
    try {
      application = await launchDesktop(dataDirectory);
      const page = await firstPage(application);
      await page.getByRole('button', { name: '文献', exact: true }).click();
      await page.getByRole('button', { name: '手动录入', exact: true }).click();
      await page.getByRole('dialog').getByLabel('标题').fill('原生 PDF 资料');
      await page.getByRole('button', { name: '保存到本地' }).click();
      await expect(page.getByText('原生 PDF 资料')).toBeVisible();
      await page.getByRole('button', { name: '编辑原生 PDF 资料', exact: true }).click();

      // A canceled native picker must leave the paper unchanged.
      await installDialogPlan(application, { openFiles: [null], directories: [], saves: [] });
      await page.getByRole('button', { name: '导入 PDF 文件' }).click();
      await expect(page.getByText('PDF 附件（0）')).toBeVisible();

      await installDialogPlan(application, { openFiles: [sourcePdf], directories: [], saves: [] });
      await page.getByRole('button', { name: '导入 PDF 文件' }).click();
      await expect(page.getByText('PDF 已保存到本地')).toBeVisible();
      await expect(page.getByText('输入资料.pdf')).toBeVisible();

      await installDialogPlan(application, { openFiles: [], directories: [], saves: [exportedPdf] });
      await page.getByRole('button', { name: '导出', exact: true }).last().click();
      await expect.poll(async () => {
        try { return (await fs.readFile(exportedPdf)).toString(); } catch { return ''; }
      }).toContain('fixture native ui');

      await page.getByRole('button', { name: '关闭编辑器' }).click();
      await page.getByRole('button', { name: '资料与设置', exact: true }).click();
      await installDialogPlan(application, { openFiles: [], directories: [], saves: [backupZip] });
      await page.getByRole('button', { name: /备份/ }).first().click();
      await expect.poll(async () => {
        try { return (await fs.stat(backupZip)).size; } catch { return 0; }
      }).toBeGreaterThan(0);
      const manifest = verifyBackup(new Uint8Array(await fs.readFile(backupZip))).manifest;
      expect(manifest.files.some(file => file.path.endsWith('.pdf'))).toBe(true);

      await installDialogPlan(application, { openFiles: [backupZip], directories: [restoreTarget], saves: [] });
      await page.getByRole('button', { name: /选择.*备份|导入.*备份/ }).click();
      await expect(page.getByText(/个文件|备份已校验|已选择/).first()).toBeVisible();
      await page.getByRole('button', { name: /选择.*目录|恢复目录/ }).click();
      await expect(page.getByText(restoreTarget)).toBeVisible();
      await page.getByRole('button', { name: /开始恢复|恢复资料/ }).click();
      await expect(page.getByText(/恢复完成/)).toBeVisible();
      expect(JSON.parse(await fs.readFile(path.join(dataDirectory, 'control', 'active-workspace.json'), 'utf8')).path).toBe(await fs.realpath(restoreTarget));

      await application.close();
      application = await launchDesktop(dataDirectory);
      const restarted = await firstPage(application);
      await restarted.getByRole('button', { name: '文献', exact: true }).click();
      await restarted.getByRole('button', { name: '编辑原生 PDF 资料', exact: true }).click();
      await expect(restarted.getByText('输入资料.pdf')).toBeVisible();
      const loopbackOrigin = new URL(restarted.url()).origin;
      await application.close();
      application = undefined;
      await expect.poll(async () => {
        try { await fetch(`${loopbackOrigin}/api/session`); return true; } catch { return false; }
      }).toBe(false);
    } finally {
      await application?.close();
      application = undefined;
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
