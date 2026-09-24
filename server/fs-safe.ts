import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export class AppError extends Error { constructor(message: string, public status = 400, public code = 'INVALID') { super(message); } }
export const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function relativePath(value: string): string {
  if (!value || value !== value.normalize('NFC') || /[\\\x00-\x1f:<>"|?*]/.test(value) || value.startsWith('/')) throw new AppError('不安全的资料路径');
  for (const part of value.split('/')) if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new AppError('不安全的 Windows 文件名');
  return value;
}
function samePath(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b;
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function verifyDirectoryIdentity(root: string, directory: string, canonicalRoot: string) {
  const real = await fs.realpath(directory);
  if (!samePath(real, directory) || !inside(canonicalRoot, real)) throw new AppError('资料路径的父目录身份已变化');
}
// Node's path APIs cannot atomically bind every parent identity to the later open/rename.
// The checks below reject ordinary links and reparse aliases; a hostile same-user race still
// needs native handle-relative I/O (and Windows reparse-point handles) for a complete guarantee.
export async function exists(file: string) { try { await fs.lstat(file); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } }
export async function safePath(root: string, relative: string, createParents = false): Promise<string> {
  relativePath(relative);
  const canonicalRoot = await fs.realpath(root);
  if (!samePath(canonicalRoot, root)) throw new AppError('资料根目录身份已变化');
  let current = root; const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]); let stat;
    try { stat = await fs.lstat(current); } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      if (i < parts.length - 1 && createParents) { await fs.mkdir(current); stat = await fs.lstat(current); }
      else if (i < parts.length - 1) throw e;
    }
    if (stat?.isSymbolicLink() || (stat && i < parts.length - 1 && !stat.isDirectory())) throw new AppError('资料路径不能包含链接或非目录');
    if (stat?.isDirectory()) await verifyDirectoryIdentity(root, current, canonicalRoot);
    else await verifyDirectoryIdentity(root, path.dirname(current), canonicalRoot);
  }
  if (!samePath(await fs.realpath(root), canonicalRoot)) throw new AppError('资料根目录身份已变化');
  return current;
}
export async function readSafe(root: string, rel: string): Promise<Buffer> {
  const file = await safePath(root, rel), handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink > 1) throw new AppError('只允许普通独立文件'); return await handle.readFile(); } finally { await handle.close(); }
}
export async function atomicWrite(root: string, rel: string, content: string | Uint8Array, beforeCommit?: () => void | Promise<void>): Promise<void> {
  const file = await safePath(root, rel, true), tmp = `${file}.${randomUUID()}.tmp`, handle = await fs.open(tmp, 'wx', 0o600);
  try {
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await safePath(root, rel); await beforeCommit?.(); await fs.rename(tmp, file);
    try {
      const dir = await fs.open(path.dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (e: any) {
      if (!(process.platform === 'win32' && ['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM', 'EISDIR'].includes(e.code))) throw e;
    }
  } finally { await fs.rm(tmp, { force: true }); }
}
export async function listFiles(root: string, prefix = ''): Promise<string[]> {
  let start: string;
  try { start = prefix ? await safePath(root, prefix) : root; } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  if (!await exists(start)) return [];
  const result: string[] = [];
  async function walk(dir: string, rel: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new AppError('资料目录中存在符号链接，请移除后重试');
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), next);
      else if (entry.isFile() && !entry.name.endsWith('.tmp') && entry.name !== '.DS_Store') result.push(next);
    }
  }
  await walk(start, prefix); return result.sort();
}
