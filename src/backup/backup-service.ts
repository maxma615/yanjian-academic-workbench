import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import type { BackupManifest } from '../shared/types';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 20_000;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalPath(name: string): string {
  if (!name || name.includes('\\') || name.startsWith('/') || name.startsWith('//') || /^[A-Za-z]:/.test(name) || /[<>:"|?*\u0000-\u001f\u007f]/.test(name)) throw new Error(`unsafe path: ${name}`);
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error(`unsafe path: ${name}`);
  for (const part of parts) {
    const stem = part.split('.')[0].toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) throw new Error(`reserved path: ${name}`);
  }
  return name.normalize('NFC');
}

function collisionKey(name: string): string { return name.normalize('NFC').toLocaleLowerCase('en-US'); }

function isAllowedFile(name: string): boolean {
  if (name === 'workspace.json') return true;
  if (/^notes\/[^/]+\.md$/.test(name)) return true;
  if (/^logs\/[^/]+(?:\/[^/]+)*\.md$/.test(name)) return true;
  if (/^papers\/[^/]+\/metadata\.json$/.test(name)) return true;
  if (/^papers\/.+\/attachments\/.+\.pdf$/.test(name)) return true;
  if (/^tasks\/[^/]+\.json$/.test(name) || /^events\/[^/]+\.json$/.test(name)) return true;
  if (/^tombstones\/[^/]+(?:\/[^/]+)*\.json$/.test(name)) return true;
  if (/^deletion-snapshots\/.+/.test(name)) return true;
  if (/^conflicts\/[^/]+\/manifest\.json$/.test(name)) return true;
  if (/^conflicts\/[^/]+\/.+\.(?:md|txt|json)$/.test(name)) return true;
  return false;
}

async function readRegularFile(file: string): Promise<Uint8Array> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) throw new Error(`unsupported file type: ${file}`);
  if (before.size > MAX_FILE_BYTES) throw new Error(`file too large: ${file}`);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || !sameFileIdentity(before, opened) || opened.size !== before.size) throw new Error(`file identity changed: ${file}`);
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after) || after.size !== opened.size) throw new Error(`file changed while reading: ${file}`);
    return bytes;
  } finally { await handle.close(); }
}

async function collectFiles(root: string): Promise<Map<string, Uint8Array>> {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('backup root must be a directory');
  const result = new Map<string, Uint8Array>();
  let total = 0;
  async function walk(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const safe = canonicalPath(rel);
      if (entry.isDirectory()) {
        if (!['state', 'index', 'cache', 'credentials'].includes(safe.split('/')[0])) await walk(path.join(current, entry.name), safe);
        continue;
      }
      if (entry.isSymbolicLink() && ['notes', 'logs', 'papers', 'tasks', 'events', 'tombstones', 'deletion-snapshots', 'conflicts'].includes(safe.split('/')[0])) throw new Error(`unsupported authoritative link: ${safe}`);
      if (!isAllowedFile(safe)) continue;
      const bytes = await readRegularFile(path.join(current, entry.name));
      const key = collisionKey(safe);
      if ([...result.keys()].some(existing => collisionKey(existing) === key)) throw new Error(`duplicate path: ${safe}`);
      total += bytes.byteLength;
      if (total > MAX_TOTAL_BYTES || result.size >= MAX_FILES) throw new Error('backup exceeds size limits');
      result.set(safe, bytes);
    }
  }
  await walk(root, '');
  return new Map([...result.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function u16(bytes: Uint8Array, offset: number): number { return bytes[offset] | (bytes[offset + 1] << 8); }
function u32(bytes: Uint8Array, offset: number): number { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0; }

type CentralEntry = { name: string; compressedSize: number; uncompressedSize: number; method: number; flags: number; localOffset: number; externalAttributes: number; madeBy: number };
function readCentralDirectory(bytes: Uint8Array): CentralEntry[] {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('archive too large');
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0 || eocd + 22 > bytes.length) throw new Error('invalid ZIP end record');
  if (u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0) throw new Error('multi-volume ZIP is not supported');
  const count = u16(bytes, eocd + 10), centralSize = u32(bytes, eocd + 12), centralOffset = u32(bytes, eocd + 16);
  if (count > MAX_FILES || centralOffset + centralSize > eocd) throw new Error('invalid ZIP central directory');
  const entries: CentralEntry[] = []; let offset = centralOffset; let totalUncompressed = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > eocd || u32(bytes, offset) !== 0x02014b50) throw new Error('invalid ZIP central entry');
    const flags = u16(bytes, offset + 8), method = u16(bytes, offset + 10), compressedSize = u32(bytes, offset + 20), uncompressedSize = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28), extraLength = u16(bytes, offset + 30), commentLength = u16(bytes, offset + 32);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || (flags & 1) !== 0 || (method !== 0 && method !== 8)) throw new Error('unsupported ZIP entry');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    if (offset + 46 + nameLength + extraLength + commentLength > eocd) throw new Error('invalid ZIP central entry bounds');
    let name: string; try { name = textDecoder.decode(nameBytes); } catch { throw new Error('invalid ZIP path encoding'); }
    name = canonicalPath(name);
    if (uncompressedSize > MAX_FILE_BYTES || compressedSize > MAX_FILE_BYTES) throw new Error('archive member too large');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_BYTES) throw new Error('archive exceeds total size limits');
    const madeBy = u16(bytes, offset + 4), externalAttributes = u32(bytes, offset + 38);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode && (unixMode & 0xf000) !== 0x8000) || ((madeBy >>> 8) === 0 && (externalAttributes & 0x10) !== 0)) throw new Error('archive contains a link or directory');
    const localOffset = u32(bytes, offset + 42);
    if (localOffset + 30 > centralOffset || u32(bytes, localOffset) !== 0x04034b50) throw new Error('invalid ZIP local entry');
    const localFlags = u16(bytes, localOffset + 6), localMethod = u16(bytes, localOffset + 8);
    const localNameLength = u16(bytes, localOffset + 26), localExtraLength = u16(bytes, localOffset + 28);
    if (localFlags !== flags || localMethod !== method) throw new Error('ZIP central/local metadata mismatch');
    if ((flags & 8) !== 0 || u32(bytes, localOffset + 18) !== compressedSize || u32(bytes, localOffset + 22) !== uncompressedSize) throw new Error('ZIP central/local size mismatch');
    if (localOffset + 30 + localNameLength + localExtraLength + compressedSize > centralOffset) throw new Error('invalid ZIP member bounds');
    let localName: string; try { localName = canonicalPath(textDecoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength))); } catch { throw new Error('invalid ZIP local path'); }
    if (localName !== name) throw new Error('ZIP path mismatch');
    entries.push({ name, compressedSize, uncompressedSize, method, flags, localOffset, externalAttributes, madeBy });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) throw new Error('invalid ZIP central directory size');
  return entries;
}

export async function createBackup(root: string): Promise<Uint8Array> {
  const files = await collectFiles(path.resolve(root));
  const manifest: BackupManifest = { schemaVersion: 1, createdAt: new Date().toISOString(), files: [...files].map(([file, bytes]) => ({ path: file, byteSize: bytes.byteLength, sha256: sha256(bytes) })) };
  const archiveEntries: Record<string, Uint8Array> = {};
  for (const [file, bytes] of files) archiveEntries[file] = bytes;
  archiveEntries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
  const archive = zipSync(archiveEntries, { level: 6 });
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('archive too large');
  verifyBackup(archive);
  return archive;
}

export function verifyBackup(bytes: Uint8Array): { manifest: BackupManifest; files: Map<string, Uint8Array> } {
  const central = readCentralDirectory(bytes);
  const seen = new Set<string>();
  for (const entry of central) {
    if (seen.has(collisionKey(entry.name))) throw new Error(`duplicate path: ${entry.name}`);
    seen.add(collisionKey(entry.name));
    if (entry.name !== 'manifest.json' && !isAllowedFile(entry.name)) throw new Error(`path is outside backup whitelist: ${entry.name}`);
  }
  let unpacked: Record<string, Uint8Array>;
  try { unpacked = unzipSync(bytes); } catch (error) { throw new Error(`invalid ZIP archive: ${error instanceof Error ? error.message : String(error)}`); }
  if (Object.keys(unpacked).length !== central.length || !unpacked['manifest.json']) throw new Error('manifest missing');
  let actualTotal = 0;
  for (const [name, member] of Object.entries(unpacked)) {
    if (canonicalPath(name) !== name || !central.some(entry => entry.name === name)) throw new Error(`ZIP normalized name mismatch: ${name}`);
    if (member.byteLength > MAX_FILE_BYTES || (actualTotal += member.byteLength) > MAX_TOTAL_BYTES) throw new Error('archive exceeds unpacked size limits');
    const centralEntry = central.find(entry => entry.name === name);
    if (!centralEntry || member.byteLength !== centralEntry.uncompressedSize) throw new Error(`ZIP unpacked size mismatch: ${name}`);
  }
  let manifest: BackupManifest;
  try { manifest = JSON.parse(textDecoder.decode(unpacked['manifest.json'])) as BackupManifest; } catch { throw new Error('invalid manifest'); }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || typeof manifest.createdAt !== 'string') throw new Error('unsupported manifest');
  const manifestSeen = new Set<string>();
  const files = new Map<string, Uint8Array>();
  for (const item of manifest.files) {
    if (!item || typeof item.path !== 'string' || !Number.isSafeInteger(item.byteSize) || item.byteSize < 0 || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error('invalid manifest entry');
    const safe = canonicalPath(item.path);
    if (safe !== item.path || manifestSeen.has(collisionKey(safe)) || safe === 'manifest.json' || !isAllowedFile(safe)) throw new Error(`invalid manifest path: ${item.path}`);
    manifestSeen.add(collisionKey(safe));
    const member = unpacked[safe];
    if (!member || member.byteLength !== item.byteSize || sha256(member) !== item.sha256) throw new Error(`checksum mismatch: ${safe}`);
    files.set(safe, member);
  }
  if (!manifestSeen.has(collisionKey('workspace.json'))) throw new Error('backup manifest must include workspace.json');
  const archiveFiles = central.filter(entry => entry.name !== 'manifest.json').map(entry => entry.name);
  if (archiveFiles.length !== manifest.files.length || archiveFiles.some(file => !manifestSeen.has(collisionKey(file)))) throw new Error('manifest and archive entries differ');
  return { manifest, files: new Map([...files.entries()].sort(([a], [b]) => a.localeCompare(b))) };
}

type TargetIdentity = { realPath: string; dev: number; ino: number; ctimeMs: number; birthtimeMs: number };
function sameFileIdentity(a: { dev: number; ino: number; ctimeMs: number; birthtimeMs: number }, b: { dev: number; ino: number; ctimeMs: number; birthtimeMs: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino && ((a.dev !== 0 || a.ino !== 0) || (a.ctimeMs === b.ctimeMs && a.birthtimeMs === b.birthtimeMs));
}
type RestoreOptions = { getActiveRoot: () => string; validateStaged: (root: string) => Promise<void>; activate: (root: string) => Promise<void>; stagingDirectory?: string };
type RestoreResult = { dataDirectory: string; cleanupWarning?: string };

async function identity(target: string): Promise<TargetIdentity> {
  const selectedStat = await fs.lstat(target);
  if (selectedStat.isSymbolicLink()) throw new Error('restore target cannot be a symbolic link');
  const realPath = await fs.realpath(target), stat = await fs.lstat(realPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('restore target must be a real directory');
  return { realPath, dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs };
}
function sameIdentity(a: TargetIdentity, b: TargetIdentity): boolean { return a.realPath === b.realPath && sameFileIdentity(a, b); }
async function assertIdentity(target: TargetIdentity): Promise<void> {
  const stat = await fs.lstat(target.realPath);
  if (!sameIdentity(target, { realPath: await fs.realpath(target.realPath), dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs })) throw new Error('restore target identity changed');
}
function within(parent: string, child: string): boolean { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
async function assertWritableEmpty(target: TargetIdentity): Promise<void> {
  await assertIdentity(target);
  const stat = await fs.lstat(target.realPath);
  if ((stat.mode & 0o222) === 0) throw new Error('restore target is not writable');
  if ((await fs.readdir(target.realPath)).length !== 0) throw new Error('restore target must be empty');
}

async function makeManagedStagingDirectory(base: string): Promise<string> {
  const absolute = path.resolve(base);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('restore staging path is not a managed directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(cursor);
    }
  }
  return fs.mkdtemp(path.join(absolute, 'restore-'));
}

async function verifyExpectedFiles(root: string, expected: Map<string, Uint8Array>): Promise<void> {
  for (const [name, bytes] of expected) {
    const file = path.join(root, ...name.split('/'));
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size !== bytes.byteLength) throw new Error(`staged file changed: ${name}`);
    const actual = await readRegularFile(file);
    if (actual.byteLength !== bytes.byteLength || sha256(actual) !== sha256(bytes)) throw new Error(`staged checksum mismatch: ${name}`);
  }
}

async function listRegularPaths(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string, relative: string): Promise<void> {
    const currentStat = await fs.lstat(current);
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) throw new Error(`restore target contains a linked directory: ${relative || '.'}`);
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`restore target contains a symbolic link: ${rel}`);
      if (entry.isDirectory()) await walk(file, rel);
      else if (entry.isFile()) {
        const stat = await fs.lstat(file);
        if (stat.nlink > 1) throw new Error(`restore target contains a hard link: ${rel}`);
        files.push(canonicalPath(rel));
      }
    }
  }
  await walk(root, '');
  return files;
}

export class RestoreManager {
  private readonly targets = new Map<string, TargetIdentity>();
  constructor(private readonly options: RestoreOptions) {}

  async selectTarget(selectedPath: string): Promise<{ token: string; displayPath: string }> {
    if (!path.isAbsolute(selectedPath)) throw new Error('restore target must be selected as an absolute path');
    const target = await identity(selectedPath);
    const active = await fs.realpath(this.options.getActiveRoot());
    if (within(active, target.realPath) || within(target.realPath, active)) throw new Error('restore target cannot be active workspace or its parent/child');
    await assertWritableEmpty(target);
    const token = randomBytes(32).toString('hex'); this.targets.set(token, target);
    return { token, displayPath: target.realPath };
  }

  async restore(bytes: Uint8Array, token: string): Promise<RestoreResult> {
    const target = this.targets.get(token); if (!target) throw new Error('invalid or expired restore token');
    this.targets.delete(token);
    const verified = verifyBackup(bytes);
    await assertWritableEmpty(target);
    const active = await fs.realpath(this.options.getActiveRoot());
    if (within(active, target.realPath) || within(target.realPath, active)) throw new Error('restore target became active workspace or its parent/child');
    const activeRoot = await fs.realpath(this.options.getActiveRoot());
    const stagingBase = this.options.stagingDirectory ?? path.join(activeRoot, 'state', 'restore-staging');
    const staged = await makeManagedStagingDirectory(stagingBase);
    const madeFiles: Array<{ path: string; identity: TargetIdentity }> = [];
    const madeDirs: string[] = [];
    const cleanupWarnings: string[] = [];
    let activated = false;
    let result: RestoreResult | undefined;
    try {
      for (const [name, content] of verified.files) {
        const parts = name.split('/'); let current = staged;
        for (const part of parts.slice(0, -1)) {
          current = path.join(current, part); await fs.mkdir(current, { recursive: true });
          const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('staged path escaped through link');
        }
        const destination = path.join(staged, ...parts); await fs.writeFile(destination, content, { flag: 'wx', mode: 0o600 });
      }
      await this.options.validateStaged(staged);
      await verifyExpectedFiles(staged, verified.files);
      await assertWritableEmpty(target);
      for (const [name] of verified.files) {
        await assertIdentity(target);
        const parts = name.split('/'); let current = target.realPath;
        for (const part of parts.slice(0, -1)) {
          current = path.join(current, part);
          try { const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('restore target path changed'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await fs.mkdir(current); madeDirs.push(current); }
        }
        await assertIdentity(target);
        const destination = path.join(target.realPath, ...parts);
        await fs.copyFile(path.join(staged, ...parts), destination, fsConstants.COPYFILE_EXCL);
        const stat = await fs.lstat(destination); madeFiles.push({ path: destination, identity: { realPath: destination, dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs } });
      }
      await assertIdentity(target);
      await verifyExpectedFiles(target.realPath, verified.files);
      const actualTargetFiles = await listRegularPaths(target.realPath);
      const expectedTargetFiles = [...verified.files.keys()].map(name => canonicalPath(name));
      if (actualTargetFiles.length !== expectedTargetFiles.length || actualTargetFiles.some(name => !verified.files.has(name))) throw new Error('restore target contains files outside this restore');
      await this.options.activate(target.realPath);
      activated = true;
      result = { dataDirectory: target.realPath };
    } catch (error) {
      if (!activated) {
        // Target cleanup only removes files whose inode was created during this invocation.
        for (const made of madeFiles.reverse()) {
          try { const stat = await fs.lstat(made.path); if (sameFileIdentity(stat, made.identity)) await fs.rm(made.path, { force: true }); } catch (cleanupError) { cleanupWarnings.push(`could not clean ${made.path}: ${String(cleanupError)}`); }
        }
        for (const directory of madeDirs.reverse()) { try { await fs.rmdir(directory); } catch { /* user additions can make it non-empty */ } }
      }
      if (cleanupWarnings.length && error instanceof Error) error.message += ` (cleanup warning: ${cleanupWarnings.join('; ')})`;
      throw error;
    } finally {
      try { await fs.rm(staged, { recursive: true, force: true }); }
      catch (cleanupError) {
        const warning = `could not remove restore staging ${staged}: ${String(cleanupError)}`;
        if (result) result.cleanupWarning = warning;
        else cleanupWarnings.push(warning);
      }
    }
    if (!result) throw new Error('restore did not produce an activation result');
    return result;
  }
}
