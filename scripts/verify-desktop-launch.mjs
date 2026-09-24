import { _electron as electron, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
const appRoot = process.cwd();
const executablePath = process.argv[2] || (process.platform === 'darwin'
  ? path.resolve('release/mac-arm64/YanJian Academic Workbench.app/Contents/MacOS/YanJian Academic Workbench')
  : path.resolve('release/win-unpacked/YanJian Academic Workbench.exe'));
await fs.access(executablePath);
await fs.mkdir('.test-data', { recursive: true });
const data = await fs.mkdtemp(path.resolve('.test-data/packaged-launch-'));
const temporary = path.resolve('.cache/desktop-tmp'); await fs.mkdir(temporary, { recursive: true });
const env = { ...process.env, ACADEMIC_DESKTOP_DATA_DIR: data, ELECTRON_CACHE: path.resolve('.cache/electron'), TMPDIR: temporary, TEMP: temporary, TMP: temporary };
delete env.ACADEMIC_DESKTOP_DIST_DIR;
let application;
const launch = () => electron.launch({ executablePath, args: [], env, timeout: 30_000 });
try {
  application = await launch(); let page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: '今天，继续向前一点。' })).toBeVisible();
  if (!await page.evaluate(() => Boolean(window.academicDesktop) && !window.require && !window.process)) throw new Error('Packaged renderer isolation failed');
  const versions = await application.evaluate(({ app }) => ({ electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, packaged: app.isPackaged, userData: app.getPath('userData') }));
  if (!versions.packaged || !versions.userData.startsWith(data + path.sep)) throw new Error('Expected a packaged app using isolated userData');
  await page.getByRole('button', { name: '新增待办', exact: true }).click();
  await page.getByRole('dialog').getByLabel('标题', { exact: true }).fill('已打包应用持久化验证');
  await page.getByRole('button', { name: '保存到本地', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const origin = new URL(page.url()).origin;
  await application.close(); application = undefined;
  await expect.poll(async () => { try { await fetch(origin); return 'open'; } catch { return 'closed'; } }).toBe('closed');
  application = await launch(); page = await application.firstWindow();
  await expect(page.getByText('已打包应用持久化验证', { exact: true })).toBeVisible();
  await fs.mkdir('release', { recursive: true });
  await page.screenshot({ path: path.resolve('release/packaged-launch.png'), fullPage: true });
  const result = { status: 'PASS', verifiedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, executablePath: path.relative(appRoot, executablePath), versions: { ...versions, userData: 'isolated fixture (removed after verification)' }, checks: ['packaged resources', 'sandboxed preload bridge', 'SQLite-backed save', 'restart persistence', 'profile isolation', 'loopback shutdown'] };
  await fs.writeFile('release/packaged-launch.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await application?.close(); await fs.rm(data, { recursive: true, force: true }); }
