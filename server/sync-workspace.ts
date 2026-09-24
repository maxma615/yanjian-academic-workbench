import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, atomicWrite, exists, hash, listFiles, readSafe, safePath } from './fs-safe';
import { Workspace } from './workspace';
import { selectLocalSyncFiles, validateSnapshot } from '../src/sync/scope';
import { snapshotFingerprint, type SyncBaseline, type SyncBytes, type SyncSnapshot, type SyncWorkspaceAdapter } from '../src/sync/contracts';

const JOURNAL = 'state/sync-apply.json';
const BASELINE = 'state/sync-baseline.json';
const RESOLUTIONS = 'state/sync-resolutions.json';
const MAX_SYNC_FILE_BYTES = 8 * 1024 * 1024;

type JournalEntry = { path: string; before?: string; after?: string };
type SyncJournal = { schemaVersion: 1; phase: 'prepared' | 'committed'; entries: JournalEntry[] };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const fromB64 = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
const same = (left: Uint8Array | undefined, right: Uint8Array | undefined) => left === undefined ? right === undefined : right !== undefined && hash(left) === hash(right) && left.length === right.length;
const syncPath = (value: string) => /^(?:notes\/[0-9a-f-]{36}\.md|logs\/\d{4}\/[0-9a-f-]{36}\.md|papers\/[0-9a-f-]{36}\/metadata\.json|tombstones\/(?:note|log|paper)\/[0-9a-f-]{36}\.json|conflicts\/[0-9a-f-]{36}\/(?:manifest\.json|notes\/[0-9a-f-]{36}\.md|logs\/\d{4}\/[0-9a-f-]{36}\.md|papers\/[0-9a-f-]{36}\/metadata\.json))$/i.test(value);
function decodeJournalBytes(value: unknown, field: string): Uint8Array | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new AppError(`同步提交日志 ${field} 无效`, 423, 'SYNC_RECOVERY_REQUIRED');
  const bytes = fromB64(value); if (bytes.length > MAX_SYNC_FILE_BYTES) throw new AppError('同步提交日志文件过大', 423, 'SYNC_RECOVERY_REQUIRED');
  return bytes;
}

async function readOptional(root: string, relative: string) {
  try { return await readSafe(root, relative); } catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error; }
}

async function readAllSyncFiles(root: string): Promise<SyncSnapshot> {
  const files = new Map<string, SyncBytes>();
  const candidates = (await Promise.all(['notes', 'logs', 'tombstones', 'conflicts'].map(prefix => listFiles(root, prefix)))).flat();
  // Papers need special handling: listFiles(papers) would traverse and inspect
  // every local PDF attachment. Only metadata.json is a sync candidate.
  const papersRoot = path.join(root, 'papers');
  if (await exists(papersRoot)) {
    for (const entry of await fs.readdir(papersRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new AppError('文献目录中存在符号链接，请移除后重试');
      if (!entry.isDirectory()) continue;
      const metadata = path.join(papersRoot, entry.name, 'metadata.json');
      try { const stat = await fs.lstat(metadata); if (stat.isSymbolicLink()) throw new AppError('文献元数据不能是符号链接'); if (stat.isFile()) candidates.push(`papers/${entry.name}/metadata.json`); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
  for (const relative of candidates) {
    // readSafe performs the same path and ordinary-file checks a write uses.
    const bytes = await readSafe(root, relative);
    if (bytes.length > MAX_SYNC_FILE_BYTES && /^(?:notes|logs|papers|tombstones|conflicts)\//.test(relative)) throw new AppError(`同步文本过大：${relative}`, 413, 'SYNC_SCOPE_INVALID');
    files.set(relative, bytes);
  }
  return selectLocalSyncFiles({ files });
}

function parseBaseline(bytes: Uint8Array): SyncBaseline {
  let value: any;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new AppError('同步基线格式损坏', 400, 'SYNC_BASELINE_INVALID'); }
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.files) || (value.revision !== undefined && typeof value.revision !== 'string')) throw new AppError('同步基线格式损坏', 400, 'SYNC_BASELINE_INVALID');
  const files = new Map<string, SyncBytes>();
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || typeof file.base64 !== 'string' || files.has(file.path)) throw new AppError('同步基线文件清单损坏', 400, 'SYNC_BASELINE_INVALID');
    const bytes = fromB64(file.base64); if (bytes.length > MAX_SYNC_FILE_BYTES) throw new AppError('同步基线文件过大', 413, 'SYNC_BASELINE_INVALID');
    files.set(file.path, bytes);
  }
  return { schemaVersion: 1, revision: value.revision, files: validateSnapshot({ files }, { remote: false }).files };
}

export async function recoverSyncApply(root: string): Promise<void> {
  const journalBytes = await readOptional(root, JOURNAL);
  if (!journalBytes) return;
  let journal: SyncJournal;
  try { journal = JSON.parse(Buffer.from(journalBytes).toString('utf8')); } catch { throw new AppError('同步提交日志损坏，请保留资料目录并联系支持', 423, 'SYNC_RECOVERY_REQUIRED'); }
  if (journal.schemaVersion !== 1 || !['prepared', 'committed'].includes(journal.phase) || !Array.isArray(journal.entries) || journal.entries.length > 10000) throw new AppError('同步提交日志无效，请保留资料目录并联系支持', 423, 'SYNC_RECOVERY_REQUIRED');
  const seen = new Set<string>(); const decoded = new Map<string, { before?: Uint8Array; after?: Uint8Array }>();
  for (const entry of journal.entries) {
    if (!entry || typeof entry.path !== 'string' || !syncPath(entry.path) || seen.has(entry.path) || (entry.before === undefined && entry.after === undefined)) throw new AppError('同步提交日志无效，请保留资料目录并联系支持', 423, 'SYNC_RECOVERY_REQUIRED');
    const before = decodeJournalBytes(entry.before, `${entry.path}.before`), after = decodeJournalBytes(entry.after, `${entry.path}.after`);
    seen.add(entry.path); decoded.set(entry.path, { before, after });
  }
  const afterFiles = new Map<string, SyncBytes>();
  for (const [relative, value] of decoded) if (value.after !== undefined) afterFiles.set(relative, value.after);
  validateSnapshot({ files: afterFiles }, { remote: false });
  if (journal.phase === 'committed') {
    let complete = true;
    for (const entry of journal.entries) {
      const current = await readOptional(root, entry.path);
      if (!same(current, decoded.get(entry.path)!.after)) { complete = false; break; }
    }
    if (complete) { await fs.rm(await safePath(root, JOURNAL), { force: true }); return; }
    throw new AppError('同步提交日志显示外部资料已变化，已停止恢复；请保留资料目录并人工检查', 423, 'SYNC_RECOVERY_REQUIRED');
  }
  // A prepared or incomplete committed transaction rolls back to the exact
  // byte snapshots recorded before the batch. It never touches excluded files.
  for (const entry of journal.entries) {
    const before = decoded.get(entry.path)!.before;
    const after = decoded.get(entry.path)!.after;
    const current = await readOptional(root, entry.path);
    if (!same(current, before) && !same(current, after)) throw new AppError('同步提交日志对应资料已被外部修改，已停止恢复；请人工检查', 423, 'SYNC_RECOVERY_REQUIRED');
    if (before === undefined) await fs.rm(await safePath(root, entry.path), { force: true }).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; });
    else await atomicWrite(root, entry.path, before);
  }
  await fs.rm(await safePath(root, JOURNAL), { force: true });
}

export class WorkspaceSyncAdapter implements SyncWorkspaceAdapter {
  constructor(private readonly workspace: Workspace) {}
  private root() { return this.workspace.root; }
  async readSyncSnapshot() { return readAllSyncFiles(this.root()); }
  async readSyncBaseline() {
    const bytes = await readOptional(this.root(), BASELINE);
    return bytes ? parseBaseline(bytes) : undefined;
  }
  async writeSyncBaseline(baseline: SyncBaseline) {
    const files = validateSnapshot({ files: baseline.files }, { remote: false }).files;
    const payload = { schemaVersion: 1, ...(baseline.revision ? { revision: baseline.revision } : {}), files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => ({ path: file, base64: b64(bytes) })) };
    await this.workspace.exclusive(() => this.workspace.syncWriteAtomically(BASELINE, JSON.stringify(payload, null, 2) + '\n'));
  }
  async readSyncResolutions() {
    const bytes = await readOptional(this.root(), RESOLUTIONS);
    if (!bytes) return new Map<string, { remoteRevision?: string; remote?: SyncBytes }>();
    let value: any; try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new AppError('同步解决记录格式损坏', 423, 'SYNC_RECOVERY_REQUIRED'); }
    if (!value || value.schemaVersion !== 1 || !value.items || typeof value.items !== 'object') throw new AppError('同步解决记录格式损坏', 423, 'SYNC_RECOVERY_REQUIRED');
    const result = new Map<string, { remoteRevision?: string; remote?: SyncBytes }>();
    for (const [relative, item] of Object.entries(value.items as Record<string, any>)) {
      if (!syncPath(relative) || !item || (item.remoteRevision !== undefined && typeof item.remoteRevision !== 'string')) throw new AppError('同步解决记录路径无效', 423, 'SYNC_RECOVERY_REQUIRED');
      const remote = item.remoteBase64 === undefined ? undefined : decodeJournalBytes(item.remoteBase64, `${relative}.remote`);
      result.set(relative, { remoteRevision: item.remoteRevision, ...(remote ? { remote } : {}) });
    }
    return result;
  }
  async recordSyncResolution(relative: string, resolution: { remoteRevision?: string; remote?: SyncBytes }) {
    if (!syncPath(relative)) throw new AppError('同步解决记录路径无效');
    await this.workspace.exclusive(async () => {
      const existing = await this.readSyncResolutions();
      existing.set(relative, resolution);
      const items = Object.fromEntries([...existing].sort(([a], [b]) => a.localeCompare(b)).map(([file, item]) => [file, { ...(item.remoteRevision ? { remoteRevision: item.remoteRevision } : {}), ...(item.remote ? { remoteBase64: b64(item.remote) } : {}) }]));
      await this.workspace.syncWriteAtomically(RESOLUTIONS, JSON.stringify({ schemaVersion: 1, items }, null, 2) + '\n');
    });
  }
  async clearSyncResolutions(paths?: string[]) {
    await this.workspace.exclusive(async () => {
      if (!paths) { await fs.rm(await safePath(this.root(), RESOLUTIONS), { force: true }).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; }); return; }
      const existing = await this.readSyncResolutions(); for (const relative of paths) existing.delete(relative);
      const items = Object.fromEntries([...existing].map(([file, item]) => [file, { ...(item.remoteRevision ? { remoteRevision: item.remoteRevision } : {}), ...(item.remote ? { remoteBase64: b64(item.remote) } : {}) }]));
      await this.workspace.syncWriteAtomically(RESOLUTIONS, JSON.stringify({ schemaVersion: 1, items }, null, 2) + '\n');
    });
  }
  async archiveSyncConflict(conflictId: string, files: Map<string, SyncBytes>) {
    if (!/^[0-9a-f-]{36}$/i.test(conflictId)) throw new AppError('同步冲突标识无效');
    await this.workspace.exclusive(async () => {
      for (const [source, bytes] of files) {
        if (bytes.length > MAX_SYNC_FILE_BYTES || !source.startsWith(`conflicts/${conflictId}/`)) throw new AppError('同步冲突证据无效');
        const suffix = source.slice(`conflicts/${conflictId}/`.length);
        if (!suffix || suffix.includes('..') || suffix.includes('\\')) throw new AppError('同步冲突证据路径无效');
        await this.workspace.syncWriteAtomically(`deletion-snapshots/sync-conflicts/${conflictId}/${suffix}`, bytes);
      }
    });
  }
  async applySyncSnapshot(snapshot: SyncSnapshot, expectedFingerprint: string) {
    return this.workspace.exclusive(async () => {
      const current = await this.readSyncSnapshot();
      if (snapshotFingerprint(current) !== expectedFingerprint) throw new AppError('本地资料在同步过程中发生变化，请重新同步', 409, 'CONFLICT');
      const desired = validateSnapshot(snapshot, { remote: false });
      const paths = [...new Set([...current.files.keys(), ...desired.files.keys()])].sort();
      const entries: JournalEntry[] = paths.map(relative => ({ path: relative, ...(current.files.has(relative) ? { before: b64(current.files.get(relative)!) } : {}), ...(desired.files.has(relative) ? { after: b64(desired.files.get(relative)!) } : {}) }));
      await this.workspace.syncWriteAtomically(JOURNAL, JSON.stringify({ schemaVersion: 1, phase: 'prepared', entries }, null, 2) satisfies string);
      try {
        for (const entry of entries) {
          const after = entry.after === undefined ? undefined : fromB64(entry.after);
          if (after === undefined) await this.workspace.syncRemove(entry.path, current.files.has(entry.path) ? hash(current.files.get(entry.path)!) : undefined);
          else if (!same(current.files.get(entry.path), after)) await this.workspace.syncWriteAtomically(entry.path, after);
        }
        await this.workspace.syncRefreshIndex();
        await this.workspace.syncWriteAtomically(JOURNAL, JSON.stringify({ schemaVersion: 1, phase: 'committed', entries }, null, 2));
        await fs.rm(await safePath(this.root(), JOURNAL), { force: true });
      } catch (error) {
        await recoverSyncApply(this.root());
        throw error;
      }
    });
  }
}
