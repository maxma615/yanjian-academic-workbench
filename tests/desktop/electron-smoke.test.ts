import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { verifyBackup } from '../../src/backup/backup-service';

const appRoot = path.resolve(process.cwd());
const bundleRoot = path.join(appRoot, '.test-data', 'desktop-playwright-bundle');
const mainBundle = path.join(bundleRoot, 'main.cjs');

async function buildDesktopBundle(): Promise<void> {
  process.env.ELECTRON_CACHE ||= path.join(appRoot, '.cache/electron');
  process.env.TMPDIR ||= path.join(appRoot, '.cache/desktop-tmp');
  await fs.mkdir(process.env.TMPDIR, { recursive: true });
  await fs.rm(bundleRoot, { recursive: true, force: true });
  await fs.mkdir(bundleRoot, { recursive: true });
  buildSync({ entryPoints: [path.join(appRoot, 'electron/main.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: mainBundle });
  buildSync({ entryPoints: [path.join(appRoot, 'electron/preload.ts')], bundle: true, platform: 'browser', format: 'cjs', external: ['electron'], outfile: path.join(bundleRoot, 'preload.cjs') });
  await fs.access(path.join(appRoot, 'dist/index.html'));
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
      await page.getByRole('button', { name: /录入第一篇文献|新增文献/ }).click();
      await page.getByRole('dialog').getByLabel('标题').fill('原生 PDF 资料');
      await page.getByRole('button', { name: '保存到本地' }).click();
      await expect(page.getByText('原生 PDF 资料')).toBeVisible();
      await page.getByText('原生 PDF 资料').first().click();

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
      await restarted.getByText('原生 PDF 资料').first().click();
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
