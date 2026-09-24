import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import express from 'express';
import type { Server } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app';
import { EncryptedCredentialStore } from './credentials';
import { NativeService, type FileDialogPort, type ShellPort } from './native-service';
import { isTrustedIpcSender } from './ipc-security';

// electron-builder emits CommonJS. The cwd fallback keeps direct `tsx` smoke
// runs usable when launched from the application directory.
const here = typeof __dirname === 'string' ? __dirname : path.resolve(process.cwd(), 'electron');
app.setName('YanJian');
if (process.env.ACADEMIC_DESKTOP_DATA_DIR) {
  // Tests get a disposable Chromium profile as well as a disposable data
  // directory. Never reuse the developer's real Electron profile in a fixture.
  app.setPath('userData', path.join(path.resolve(process.env.ACADEMIC_DESKTOP_DATA_DIR), '.electron-profile'));
}
const mainWindowRef: { current?: BrowserWindow } = {};
let httpServer: Server | undefined;
let appHandle: Awaited<ReturnType<typeof createApp>> | undefined;
let nativeService: NativeService | undefined;
let loopbackOrigin = '';
let quitting = false;

function dataDirectories(): { workspace: string; control: string } {
  const override = process.env.ACADEMIC_DESKTOP_DATA_DIR;
  const base = override ? path.resolve(override) : path.join(app.getPath('userData'), 'data');
  return { workspace: path.join(base, 'workspace'), control: path.join(base, 'control') };
}

function assertSender(event: Parameters<typeof isTrustedIpcSender>[0]): void {
  const window = mainWindowRef.current;
  if (!window || !isTrustedIpcSender(event, window.webContents.id, loopbackOrigin)) throw new Error('未授权的桌面调用');
}

function stringArg(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label}无效`);
  return value;
}

function revisionArg(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('资料版本无效');
  return value as number;
}

async function makeDialogs(window: BrowserWindow): Promise<FileDialogPort> {
  return {
    async openFile(options) {
      const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: options.filters });
      return result.canceled || !result.filePaths[0] ? { canceled: true } : { canceled: false, path: result.filePaths[0] };
    },
    async openDirectory() {
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
      return result.canceled || !result.filePaths[0] ? { canceled: true } : { canceled: false, path: result.filePaths[0] };
    },
    async saveFile(options) {
      const result = await dialog.showSaveDialog(window, { defaultPath: options.defaultPath, filters: options.filters });
      if (result.canceled || !result.filePath) return { canceled: true };
      let overwriteConfirmed = false;
      try {
        const stat = await fs.lstat(result.filePath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('现有目标不是可安全替换的独立文件');
        const confirmation = await dialog.showMessageBox(window, {
          type: 'warning',
          buttons: ['覆盖', '取消'],
          defaultId: 1,
          cancelId: 1,
          title: '确认覆盖',
          message: '目标文件已存在，是否覆盖？',
        });
        overwriteConfirmed = confirmation.response === 0;
        if (!overwriteConfirmed) return { canceled: true };
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      return { canceled: false, path: result.filePath, overwriteConfirmed };
    },
  };
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 960,
    minHeight: 680,
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindowRef.current = window;
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(loopbackOrigin + '/')) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('closed', () => {
    if (mainWindowRef.current === window) mainWindowRef.current = undefined;
  });
  await window.loadURL(loopbackOrigin + '/');
  window.show();
  return window;
}

function registerIpc(window: BrowserWindow): void {
  const secure = <T extends unknown[]>(name: string, handler: (...args: T) => Promise<unknown>) => {
    ipcMain.handle(name, async (event, ...args: T) => {
      assertSender(event);
      if (event.sender.id !== window.webContents.id) throw new Error('未授权的桌面调用');
      return handler(...args);
    });
  };
  secure('desktop:import-pdf', (id, revision) => nativeService!.importPdf(stringArg(id, '文献标识'), revisionArg(revision)));
  secure('desktop:open-pdf', (id, attachmentId) => nativeService!.openPdf(stringArg(id, '文献标识'), stringArg(attachmentId, '附件标识')));
  secure('desktop:export-pdf', (id, attachmentId) => nativeService!.exportPdf(stringArg(id, '文献标识'), stringArg(attachmentId, '附件标识')));
  secure('desktop:export-entity', id => nativeService!.exportEntity(stringArg(id, '资料标识')));
  secure('desktop:backup', () => nativeService!.backup());
  secure('desktop:choose-restore-archive', () => nativeService!.chooseRestoreArchive());
  secure('desktop:choose-restore-target', () => nativeService!.chooseRestoreTarget());
  secure('desktop:restore', (archiveToken, targetToken) => nativeService!.restore(stringArg(archiveToken, '备份选择'), stringArg(targetToken, '恢复目录选择')));
}

async function start(): Promise<void> {
  const directories = dataDirectories();
  await fs.mkdir(directories.workspace, { recursive: true });
  await fs.mkdir(directories.control, { recursive: true });
  const credentialStore = new EncryptedCredentialStore(directories.control, {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: value => safeStorage.encryptString(value),
    decryptString: bytes => safeStorage.decryptString(bytes),
    getSelectedStorageBackend: process.platform === 'linux' ? () => safeStorage.getSelectedStorageBackend() : undefined,
  });
  // The HTTP app remains the single business boundary. nativeDialogs tells the
  // host integration to keep restore path selection in this main process.
  appHandle = await createApp(directories.workspace, {
    controlDirectory: directories.control,
    nativeDialogs: true,
    sync: {
      credentialsAvailable: () => {
        if (!safeStorage.isEncryptionAvailable()) return false;
        if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
        return true;
      },
      credentials: {
        getToken: async () => (await credentialStore.get()) ?? undefined,
        setToken: token => credentialStore.set(token),
        clear: () => credentialStore.delete(),
      },
    },
  });
  appHandle.app.use((_request, response, next) => {
    response.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '));
    next();
  });
  const dist = process.env.ACADEMIC_DESKTOP_DIST_DIR
    ? path.resolve(process.env.ACADEMIC_DESKTOP_DIST_DIR)
    : path.resolve(here, '../dist');
  appHandle.app.use(express.static(dist, { index: 'index.html' }));
  appHandle.app.use((request, response, next) => {
    if (request.method === 'GET' && !request.path.startsWith('/api/')) {
      response.sendFile(path.join(dist, 'index.html'), error => { if (error) next(error); });
      return;
    }
    next();
  });
  httpServer = appHandle.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    httpServer!.once('listening', () => resolve());
    httpServer!.once('error', reject);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('桌面服务未能监听本机端口');
  loopbackOrigin = `http://127.0.0.1:${address.port}`;
  const window = await createWindow();
  const dialogs = await makeDialogs(window);
  nativeService = new NativeService({
    dialogs,
    shell: { openPath: filePath => shell.openPath(filePath) } satisfies ShellPort,
    runWithWorkspace: work => appHandle!.runWithWorkspace(active => work(active)),
    restore: { selectRestoreTarget: selectedPath => appHandle!.selectRestoreTarget(selectedPath), restoreBackup: (bytes, token) => appHandle!.restoreBackup(bytes, token) },
  });
  registerIpc(window);
}

async function stop(): Promise<void> {
  if (httpServer) await new Promise<void>(resolve => httpServer!.close(() => resolve()));
  httpServer = undefined;
  nativeService?.clear();
  nativeService = undefined;
  await appHandle?.close();
  appHandle = undefined;
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    const window = mainWindowRef.current;
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.whenReady().then(start).catch(error => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void stop().finally(() => app.exit(0));
  });
} else {
  app.quit();
}

export { dataDirectories, isTrustedIpcSender };
