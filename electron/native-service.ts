import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createBackup, verifyBackup } from '../src/backup/backup-service';
import { safePath } from '../server/fs-safe';
import type { Entity, SaveResult } from '../src/shared/types';
import type { DesktopManifest, DesktopResult } from '../src/shared/desktop';

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export type OpenFileOptions = {
  filters?: Array<{ name: string; extensions: string[] }>;
};

export type FileDialogPort = {
  openFile(options: OpenFileOptions): Promise<{ canceled: true } | { canceled: false; path: string }>;
  openDirectory(): Promise<{ canceled: true } | { canceled: false; path: string }>;
  saveFile(options: {
    defaultPath: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: true } | { canceled: false; path: string; overwriteConfirmed: boolean }>;
};

export type ShellPort = { openPath(filePath: string): Promise<string> };

type WorkspacePort = {
  root: string;
  get(id: string): Promise<Entity>;
  importPdf(id: string, name: string, bytes: Uint8Array, revision: number): Promise<SaveResult>;
  readAttachment(id: string, attachmentId: string): Promise<{ bytes: Uint8Array; name: string }>;
  exportEntity(id: string): Promise<{ bytes: Uint8Array; name: string }>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
};

type RestorePort = {
  selectRestoreTarget(path: string): Promise<{ token: string; displayPath: string }>;
  restoreBackup(bytes: Uint8Array, token: string): Promise<{ dataDirectory: string; cleanupWarning?: string }>;
};

export type NativeServiceOptions = {
  dialogs: FileDialogPort;
  shell: ShellPort;
  runWithWorkspace<T>(work: (workspace: WorkspacePort) => Promise<T>): Promise<T>;
  restore: RestorePort;
};

type ArchiveRecord = { bytes: Uint8Array; manifest: DesktopManifest; createdAt: number };

function canceled<T extends object>(): DesktopResult<T> { return { canceled: true }; }

async function regularFile(filePath: string, maximum: number): Promise<Uint8Array> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) throw new Error('所选文件不是独立的普通文件');
  if (before.size > maximum) throw new Error('所选文件超过大小限制');
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino || opened.birthtimeMs !== before.birthtimeMs) throw new Error('所选文件身份已变化');
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (after.size !== opened.size || after.ino !== opened.ino || after.dev !== opened.dev || after.birthtimeMs !== opened.birthtimeMs || after.ctimeMs !== opened.ctimeMs || after.mtimeMs !== opened.mtimeMs) throw new Error('所选文件读取时发生变化');
    return bytes;
  } finally {
    await handle.close();
  }
}

async function parentIdentity(filePath: string): Promise<{ parent: string; realPath: string; dev: number; ino: number }> {
  const parent = path.dirname(path.resolve(filePath));
  const stat = await fs.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('导出位置的父目录无效');
  const realPath = await fs.realpath(parent);
  if (process.platform === 'win32' && path.resolve(parent).toLocaleLowerCase() !== path.resolve(realPath).toLocaleLowerCase()) throw new Error('导出位置不能通过链接或重解析点访问');
  return { parent, realPath, dev: Number(stat.dev), ino: Number(stat.ino) };
}

async function writeExport(filePath: string, bytes: Uint8Array, overwriteConfirmed: boolean): Promise<void> {
  if (!path.isAbsolute(filePath)) throw new Error('保存位置必须是绝对路径');
  const parent = await parentIdentity(filePath);
  const target = path.resolve(filePath);
  const current = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (current && (!current.isFile() || current.isSymbolicLink() || current.nlink > 1)) throw new Error('现有目标不是可安全替换的独立文件');
  if (current && !overwriteConfirmed) throw new Error('覆盖现有文件需要原生保存确认');
  const temporary = path.join(parent.realPath, `.${path.basename(target)}.${randomBytes(12).toString('hex')}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const afterParent = await parentIdentity(target);
    if (afterParent.realPath !== parent.realPath || afterParent.dev !== parent.dev || afterParent.ino !== parent.ino) throw new Error('导出位置的父目录身份已变化');
    const beforeRename = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (beforeRename && (!current || beforeRename.ino !== current.ino || beforeRename.dev !== current.dev || beforeRename.nlink > 1)) throw new Error('导出目标在保存期间发生变化');
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function manifestFrom(bytes: Uint8Array): DesktopManifest {
  return verifyBackup(bytes).manifest;
}

export class NativeService {
  private readonly archives = new Map<string, ArchiveRecord>();

  constructor(private readonly options: NativeServiceOptions) {}

  async importPdf(id: string, revision: number): Promise<DesktopResult<{ attachment: { id: string; name: string; revision: number } }>> {
    const choice = await this.options.dialogs.openFile({ filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (choice.canceled) return canceled();
    const bytes = await regularFile(choice.path, MAX_PDF_BYTES);
    if (bytes.byteLength < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('请选择有效 PDF（不超过 50 MB）');
    return this.options.runWithWorkspace(async workspace => {
      const saved = await workspace.importPdf(id, path.basename(choice.path), bytes, revision);
      const attachment = saved.entity.attachments?.at(-1);
      if (!attachment) throw new Error('PDF 已保存但附件记录缺失');
      return { canceled: false, attachment: { id: attachment.id, name: attachment.name, revision: saved.entity.revision } };
    });
  }

  async openPdf(id: string, attachmentId: string): Promise<DesktopResult<{ openedPath: string }>> {
    return this.options.runWithWorkspace(async workspace => {
      const paper = await workspace.get(id);
      const attachment = paper.attachments?.find(item => item.id === attachmentId);
      if (!attachment || paper.type !== 'paper') throw new Error('附件不存在');
      // readAttachment verifies the recorded hash before a path is handed to the shell.
      await workspace.readAttachment(id, attachmentId);
      const filePath = await safePath(workspace.root, attachment.path);
      const error = await this.options.shell.openPath(filePath);
      if (error) throw new Error(error);
      return { canceled: false, openedPath: filePath };
    });
  }

  async exportPdf(id: string, attachmentId: string): Promise<DesktopResult<{ path: string; byteSize: number }>> {
    const file = await this.options.runWithWorkspace(workspace => workspace.readAttachment(id, attachmentId));
    const choice = await this.options.dialogs.saveFile({ defaultPath: file.name, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (choice.canceled) return canceled();
    await writeExport(choice.path, file.bytes, choice.overwriteConfirmed);
    return { canceled: false, path: path.resolve(choice.path), byteSize: file.bytes.byteLength };
  }

  async exportEntity(id: string): Promise<DesktopResult<{ path: string; byteSize: number }>> {
    const file = await this.options.runWithWorkspace(workspace => workspace.exportEntity(id));
    const choice = await this.options.dialogs.saveFile({ defaultPath: file.name, filters: [{ name: '可读资料', extensions: ['md', 'json'] }] });
    if (choice.canceled) return canceled();
    await writeExport(choice.path, file.bytes, choice.overwriteConfirmed);
    return { canceled: false, path: path.resolve(choice.path), byteSize: file.bytes.byteLength };
  }

  async backup(): Promise<DesktopResult<{ path: string; byteSize: number; manifest: DesktopManifest }>> {
    const bytes = await this.options.runWithWorkspace(workspace => workspace.exclusive(() => createBackup(workspace.root)));
    const manifest = manifestFrom(bytes);
    const choice = await this.options.dialogs.saveFile({ defaultPath: `研笺-完整备份-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: 'ZIP 备份', extensions: ['zip'] }] });
    if (choice.canceled) return canceled();
    await writeExport(choice.path, bytes, choice.overwriteConfirmed);
    return { canceled: false, path: path.resolve(choice.path), byteSize: bytes.byteLength, manifest };
  }

  async chooseRestoreArchive(): Promise<DesktopResult<{ archiveToken: string; manifest: DesktopManifest }>> {
    const choice = await this.options.dialogs.openFile({ filters: [{ name: '研笺备份', extensions: ['zip'] }] });
    if (choice.canceled) return canceled();
    const bytes = await regularFile(choice.path, MAX_ARCHIVE_BYTES);
    const manifest = manifestFrom(bytes);
    const archiveToken = randomBytes(32).toString('hex');
    // Keep one user-selected archive in memory. A later selection replaces the
    // earlier opaque token, avoiding an unbounded archive-byte retention path.
    this.archives.clear();
    this.archives.set(archiveToken, { bytes, manifest, createdAt: Date.now() });
    return { canceled: false, archiveToken, manifest };
  }

  async chooseRestoreTarget(): Promise<DesktopResult<{ targetToken: string; displayPath: string }>> {
    const choice = await this.options.dialogs.openDirectory();
    if (choice.canceled) return canceled();
    const target = await this.options.restore.selectRestoreTarget(choice.path);
    return { canceled: false, targetToken: target.token, displayPath: target.displayPath };
  }

  async restore(archiveToken: string, targetToken: string): Promise<DesktopResult<{ dataDirectory: string; cleanupWarning?: string }>> {
    const archive = this.archives.get(archiveToken);
    if (!archive) throw new Error('备份选择已过期，请重新选择');
    if (Date.now() - archive.createdAt > 15 * 60 * 1000) { this.archives.delete(archiveToken); throw new Error('备份选择已过期，请重新选择'); }
    this.archives.delete(archiveToken);
    const result = await this.options.restore.restoreBackup(archive.bytes, targetToken);
    return { canceled: false, dataDirectory: result.dataDirectory };
  }

  clear() { this.archives.clear(); }
}
