import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import lockfile from 'proper-lockfile';
import { AppError, atomicWrite, exists, hash, listFiles, readSafe, safePath } from './fs-safe';
import { entityPath, isUuid, normalizeEntity, parseEntity, searchable, serializeEntity } from './entities';
import type { Entity, EntityInput, SaveResult, WorkspaceState } from '../src/shared/types';

type DeleteOperation = { id: string; entity: Entity; originalRelativePath: string; movedPath: string; snapshotPath: string; originalHash: string; deletedAt: string; completed: boolean };
type MoveOperation = { from: string; to: string; content: string; sourceHash: string; completed: boolean; retainedSource?: boolean; recoveryWarning?: string };
type LockIdentity = { dev: number; ino: number; birthtimeMs: number; ctimeMs: number };
function migrationLockPath(root: string): string { const resolved = path.resolve(root); return path.join(path.dirname(resolved), `.${path.basename(resolved)}.migration-lock`); }
export class Workspace {
  public readOnly = false;
  public indexStatus: 'ready' | 'stale' = 'stale';
  public workspaceId = '';
  private release?: () => Promise<void>;
  private database?: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private lockCompromised = false;
  private lockIdentity?: LockIdentity;
  private recoveryExcludedPaths = new Set<string>();
  public recoveryWarning?: string;
  private constructor(public root: string) {}

  static async open(directory: string): Promise<Workspace> {
    if (await exists(migrationLockPath(directory))) throw new AppError('资料目录正在迁移，请稍后重试', 423, 'MIGRATION_IN_PROGRESS');
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new AppError('资料根目录不能是符号链接');
    const root = await fs.realpath(directory), ws = new Workspace(root);
    if (await exists(migrationLockPath(root))) throw new AppError('资料目录正在迁移，请稍后重试', 423, 'MIGRATION_IN_PROGRESS');
    await safePath(root, 'state/placeholder', true);
    try { ws.release = await lockfile.lock(root, { lockfilePath: path.join(root, 'state/writer.lock'), stale: 10000, update: 2000, retries: 0, onCompromised: () => { ws.lockCompromised = true; ws.readOnly = true; } }); }
    catch (e: any) { if (e.code !== 'ELOCKED') throw e; ws.readOnly = true; }
    try {
      if (await exists(migrationLockPath(root))) throw new AppError('资料目录正在迁移，请稍后重试', 423, 'MIGRATION_IN_PROGRESS');
      await ws.captureLockIdentity();
      const syncJournal = path.join(root, 'state/sync-apply.json');
      if (await exists(syncJournal)) {
        if (ws.readOnly) throw new AppError('资料目录有未完成同步，当前实例为只读；请关闭其他实例后重试', 423, 'SYNC_RECOVERY_REQUIRED');
        const { recoverSyncApply } = await import('./sync-workspace');
        await recoverSyncApply(root);
      }
      if (!await exists(path.join(root, 'workspace.json'))) {
        if (ws.readOnly) throw new AppError('资料目录正在初始化，请稍后重试');
        await ws.writeAtomically('workspace.json', JSON.stringify({ schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString() }, null, 2));
      }
      const meta = JSON.parse((await readSafe(root, 'workspace.json')).toString());
      if (meta.schemaVersion !== 1 || !isUuid(meta.id)) throw new AppError('资料版本不受支持，已拒绝写入；请使用匹配的应用版本');
      ws.workspaceId = meta.id;
      if (!ws.readOnly) {
        await ws.recoverOperations();
        const items = await ws.list();
        if (!ws.readOnly) try { await ws.rebuildIndexUnsafe(items); } catch { ws.indexStatus = 'stale'; ws.database?.close(); ws.database = undefined; }
      } else await ws.loadCompletedMoveWarnings();
      return ws;
    } catch (e) { await ws.close(); throw e; }
  }
  assertWritable() {
    if (this.closed) throw new AppError('资料目录已关闭');
    if (this.lockCompromised) throw new AppError('资料目录写入锁已失效，已停止写入；请重新打开资料目录', 423, 'LOCK_COMPROMISED');
    if (this.recoveryWarning) throw new AppError(this.recoveryWarning, 423, 'RECOVERY_WARNING');
    if (this.readOnly) throw new AppError('此资料目录正在由其他实例使用，当前为只读', 423, 'READ_ONLY');
  }
  private lockPath() { return path.join(this.root, 'state/writer.lock'); }
  private async captureLockIdentity() {
    const stat = await fs.lstat(this.lockPath());
    this.lockIdentity = { dev: Number(stat.dev), ino: Number(stat.ino), birthtimeMs: stat.birthtimeMs, ctimeMs: stat.ctimeMs };
  }
  private lockIdentityMatches(stat: { dev: number; ino: number; birthtimeMs: number; ctimeMs: number }) {
    if (!this.lockIdentity) return false;
    if (this.lockIdentity.dev !== 0 && this.lockIdentity.ino !== 0) return this.lockIdentity.dev === Number(stat.dev) && this.lockIdentity.ino === Number(stat.ino) && this.lockIdentity.birthtimeMs === stat.birthtimeMs;
    return this.lockIdentity.birthtimeMs === stat.birthtimeMs && this.lockIdentity.ctimeMs === stat.ctimeMs;
  }
  private async assertWriterLock() {
    this.assertWritable();
    if (await exists(migrationLockPath(this.root))) {
      this.lockCompromised = true; this.readOnly = true;
      throw new AppError('资料目录正在迁移，请稍后重试', 423, 'MIGRATION_IN_PROGRESS');
    }
    if (!this.release) throw new AppError('资料目录写入锁不存在，已停止写入；请重新打开资料目录', 423, 'LOCK_COMPROMISED');
    try {
      const held = await lockfile.check(this.root, { lockfilePath: this.lockPath(), stale: 10000 });
      const stat = await fs.lstat(this.lockPath());
      if (!held || !this.lockIdentityMatches(stat)) throw new Error('lock identity changed');
    } catch {
      this.lockCompromised = true; this.readOnly = true;
      throw new AppError('资料目录写入锁已失效，已停止写入；请重新打开资料目录', 423, 'LOCK_COMPROMISED');
    }
    this.assertWritable();
  }
  private writeAtomically(relative: string, content: string | Uint8Array) { return atomicWrite(this.root, relative, content, () => this.assertWriterLock()); }
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => { this.assertWritable(); return work(); });
    this.queue = next.catch(() => undefined); return next;
  }
  async close() { if (this.closed) return; await this.queue; this.closed = true; this.database?.close(); this.database = undefined; if (this.release) { try { await this.release(); } catch (error: any) { if (error?.code !== 'ERELEASED') throw error; } finally { this.release = undefined; } } }
  async list(): Promise<Entity[]> {
    if (await exists(migrationLockPath(this.root))) throw new AppError('资料目录正在迁移，请稍后重试', 423, 'MIGRATION_IN_PROGRESS');
    const result: Entity[] = [];
    for (const prefix of ['papers', 'notes', 'logs', 'tasks', 'events']) {
      for (const file of await listFiles(this.root, prefix)) {
        if (this.recoveryExcludedPaths.has(file)) continue;
        if (!(file.endsWith('.md') || /^(?:tasks|events)\/[^/]+\.json$/.test(file) || /^papers\/[^/]+\/metadata\.json$/.test(file))) continue;
        const e = parseEntity((await readSafe(this.root, file)).toString('utf8'), file);
        if (e.attachments) e.attachments = await Promise.all(e.attachments.map(async a => {
          if (!isUuid(a.id) || a.path !== `papers/${e.id}/attachments/${a.id}.pdf`) throw new AppError('文献附件路径与身份不符');
          let available = false;
          try { available = await exists(await safePath(this.root, a.path)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
          return { ...a, available };
        }));
        result.push(e);
      }
    }
    if (new Set(result.map(e => e.id)).size !== result.length) throw new AppError('资料存在重复身份，请检查恢复记录');
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async get(id: string) { if (!isUuid(id)) throw new AppError('资料标识无效'); const e = (await this.list()).find(x => x.id === id); if (!e) throw new AppError('资料不存在或已删除', 404); return e; }
  private expected(e: Entity, revision: unknown) { if (revision !== e.revision) throw new AppError('这条资料已被修改，请重新加载后再保存；当前输入已保留', 409, 'CONFLICT'); }
  async save(input: EntityInput, id?: string): Promise<SaveResult> {
    return this.exclusive(async () => {
      const previous = id ? await this.get(id) : undefined;
      if (previous) this.expected(previous, input.expectedRevision);
      const entity = normalizeEntity(input, previous);
      const newPaperIds = entity.paperIds?.filter(pid => !previous?.paperIds?.includes(pid)) ?? [];
      if (newPaperIds.length) {
        const all = await this.list();
        for (const pid of newPaperIds) if (!all.some(e => e.type === 'paper' && e.id === pid)) throw new AppError('关联文献不存在');
      }
      const content = serializeEntity(this.withoutLocalState(entity));
      if (previous && entityPath(previous) !== entityPath(entity)) {
        const source = await readSafe(this.root, entityPath(previous));
        const op: MoveOperation = { from: entityPath(previous), to: entityPath(entity), content, sourceHash: hash(source), completed: false };
        const file = `state/moves/${randomUUID()}.json`;
        this.assertWritable(); await this.writeAtomically(file, JSON.stringify(op)); await this.finishMove(file, op);
      } else { this.assertWritable(); await this.writeAtomically(entityPath(entity), content); }
      await this.updateIndexSafely();
      return { entity, savedAt: entity.updatedAt, indexStatus: this.indexStatus };
    });
  }
  private withoutLocalState(e: Entity): Entity { return { ...e, ...(e.attachments ? { attachments: e.attachments.map(({ available, ...a }) => a) } : {}) }; }
  async importPdf(id: string, name: string, bytes: Uint8Array, revision: number): Promise<SaveResult> {
    return this.exclusive(async () => {
      const previous = await this.get(id); if (previous.type !== 'paper') throw new AppError('只能给文献添加 PDF'); this.expected(previous, revision);
      if (!name || typeof name !== 'string' || !/\.pdf$/i.test(name) || bytes.length > 50 * 1024 * 1024 || !Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))) throw new AppError('请选择有效 PDF（不超过 50 MB）');
      const aid = randomUUID(), rel = `papers/${id}/attachments/${aid}.pdf`;
      this.assertWritable(); await this.writeAtomically(rel, bytes);
      if (hash(await readSafe(this.root, rel)) !== hash(bytes)) throw new AppError('PDF 复制校验失败');
      const entity = { ...previous, revision: previous.revision + 1, updatedAt: new Date().toISOString(), attachments: [...(previous.attachments ?? []), { id: aid, name: path.basename(name), path: rel, sha256: hash(bytes), size: bytes.length, available: true }] };
      try { this.assertWritable(); await this.writeAtomically(entityPath(entity), serializeEntity(this.withoutLocalState(entity))); }
      catch (e) { await fs.rm(await safePath(this.root, rel), { force: true }); throw e; }
      await this.updateIndexSafely(); return { entity, savedAt: entity.updatedAt, indexStatus: this.indexStatus };
    });
  }
  async readAttachment(id: string, attachmentId: string) {
    const paper = await this.get(id), attachment = paper.attachments?.find(a => a.id === attachmentId);
    if (!attachment) throw new AppError('附件不存在', 404);
    if (!attachment.available) throw new AppError('附件未在此设备', 404);
    const bytes = await readSafe(this.root, attachment.path);
    if (hash(bytes) !== attachment.sha256) throw new AppError('附件校验失败，请从完整备份恢复');
    return { bytes, name: attachment.name };
  }
  async exportEntity(id: string) { const e = await this.get(id); return { bytes: await readSafe(this.root, entityPath(e)), name: `${e.title.replace(/[\\/:*?"<>|]/g, '_')}.${e.type === 'note' || e.type === 'log' ? 'md' : 'json'}` }; }
  async remove(id: string, revision: number) {
    return this.exclusive(async () => {
      const entity = await this.get(id); this.expected(entity, revision);
      const opId = randomUUID(), original = entityPath(entity), movedPath = entity.type === 'paper' ? `papers/${id}` : original;
      const op: DeleteOperation = { id: opId, entity, originalRelativePath: original, movedPath, snapshotPath: `deletion-snapshots/${opId}/${movedPath}`, originalHash: hash(await readSafe(this.root, original)), deletedAt: new Date().toISOString(), completed: false };
      this.assertWritable(); await this.writeAtomically(`state/operations/${opId}.json`, JSON.stringify(op));
      await this.finishDelete(op); await this.updateIndexSafely();
    });
  }
  private async finishDelete(op: DeleteOperation) {
    if (!isUuid(op.id) || !isUuid(op.entity.id) || !/^[0-9a-f]{64}$/i.test(op.originalHash) || op.originalRelativePath !== entityPath(op.entity) || op.movedPath !== (op.entity.type === 'paper' ? `papers/${op.entity.id}` : op.originalRelativePath) || op.snapshotPath !== `deletion-snapshots/${op.id}/${op.movedPath}`) throw new AppError('删除恢复记录无效');
    const source = await safePath(this.root, op.movedPath).catch((e: any) => { if (e.code === 'ENOENT') return path.join(this.root, op.movedPath); throw e; });
    const dest = await safePath(this.root, op.snapshotPath, true);
    const snapshotFile = op.entity.type === 'paper' ? `${op.snapshotPath}/metadata.json` : op.snapshotPath;
    if (await exists(source)) {
      if (await exists(dest)) throw new AppError('删除快照与原资料同时存在，需要检查');
      const original = await readSafe(this.root, op.originalRelativePath);
      if (hash(original) !== op.originalHash) throw new AppError('删除源资料已变化，请重新加载后重试');
      await this.assertWriterLock(); await fs.rename(source, dest);
    } else {
      if (!await exists(dest)) throw new AppError('删除恢复缺少原资料及快照');
      const snapshot = await readSafe(this.root, snapshotFile);
      if (hash(snapshot) !== op.originalHash) throw new AppError('删除快照校验失败，请检查恢复记录');
    }
    this.assertWritable(); await this.writeAtomically(`tombstones/${op.entity.type}/${op.entity.id}.json`, JSON.stringify({ schemaVersion: 1, entityType: op.entity.type, entityId: op.entity.id, originalRelativePath: op.originalRelativePath, deletedAt: op.deletedAt, contentHash: op.originalHash }, null, 2));
    this.assertWritable(); op.completed = true; await this.writeAtomically(`state/operations/${op.id}.json`, JSON.stringify(op));
  }
  private async finishMove(file: string, op: MoveOperation) {
    const e = parseEntity(op.content, op.to);
    if (e.type !== 'log' || !isUuid(e.id) || op.from === op.to || !new RegExp(`^logs/\\d{4}/${e.id}\\.md$`).test(op.from) || typeof op.sourceHash !== 'string' || !/^[0-9a-f]{64}$/i.test(op.sourceHash)) throw new AppError('日志移动记录无效');
    const source = await readSafe(this.root, op.from).catch((error: any) => { if (error?.code === 'ENOENT') return undefined; throw error; });
    if (!source) {
      const destination = await readSafe(this.root, op.to).catch((error: any) => { if (error?.code === 'ENOENT') return undefined; throw error; });
      if (!destination || hash(destination) !== hash(op.content)) throw new AppError('日志移动恢复缺少目标资料');
    } else {
      const old = parseEntity(source.toString('utf8'), op.from);
      if (old.type !== 'log' || old.id !== e.id || entityPath(old) !== op.from || hash(source) !== op.sourceHash) throw new AppError('日志移动源资料已变化，请检查恢复记录');
      this.assertWritable();
      const destination = await readSafe(this.root, op.to).catch((error: any) => { if (error?.code === 'ENOENT') return undefined; throw error; });
      if (!destination) await this.writeAtomically(op.to, op.content);
      else if (hash(destination) !== hash(op.content)) throw new AppError('日志移动目标资料已变化，请检查恢复记录');
      let warning: string | undefined;
      try { await this.assertWriterLock(); await fs.rm(await safePath(this.root, op.from), { force: true }); }
      catch (error: any) {
        if (!['EACCES', 'EPERM', 'EBUSY'].includes(error?.code)) throw error;
        warning = `日志移动已写入新年份文件，但旧日志 ${op.from} 无法删除；当前资料已只读，请处理旧文件后重试。`;
        op.retainedSource = true; op.recoveryWarning = warning;
      }
      op.completed = true; await this.writeAtomically(file, JSON.stringify(op));
      if (warning) { this.recoveryExcludedPaths.add(op.from); this.recoveryWarning = warning; this.readOnly = true; }
      return;
    }
    this.assertWritable(); op.completed = true; await this.writeAtomically(file, JSON.stringify(op));
  }
  private async registerCompletedMoveWarning(op: MoveOperation) {
    if (!op.retainedSource) return;
    const entity = parseEntity(op.content, op.to);
    if (entity.type !== 'log' || op.from === op.to || !new RegExp(`^logs/\\d{4}/${entity.id}\\.md$`).test(op.from)) throw new AppError('日志移动恢复记录无效');
    if (hash(await readSafe(this.root, op.to)) !== hash(op.content)) throw new AppError('日志移动目标资料已变化，请检查恢复记录');
    const source = await readSafe(this.root, op.from).catch((error: any) => { if (error.code === 'ENOENT') return undefined; throw error; });
    // After the retained predecessor is removed, a fresh open can safely resume
    // normal editing; the new authoritative file must still match the journal.
    if (!source) return;
    if (hash(source) !== op.sourceHash) throw new AppError('保留的旧日志已变化，请检查恢复记录');
    this.recoveryExcludedPaths.add(op.from);
    this.recoveryWarning ??= op.recoveryWarning ?? '日志移动旧文件仍保留，当前资料已只读。';
    this.readOnly = true;
  }
  private async loadCompletedMoveWarnings() {
    for (const file of await listFiles(this.root, 'state/moves')) {
      if (!file.endsWith('.json')) continue;
      const op = JSON.parse((await readSafe(this.root, file)).toString()) as MoveOperation;
      if (op.completed) await this.registerCompletedMoveWarning(op);
    }
  }
  private async recoverOperations() {
    for (const file of await listFiles(this.root, 'state/operations')) {
      if (!file.endsWith('.json')) continue;
      const op = JSON.parse((await readSafe(this.root, file)).toString()) as DeleteOperation;
      if (!op.completed) await this.finishDelete(op);
    }
    for (const file of await listFiles(this.root, 'state/moves')) {
      if (!file.endsWith('.json')) continue;
      const op = JSON.parse((await readSafe(this.root, file)).toString()) as MoveOperation;
      if (op.completed) await this.registerCompletedMoveWarning(op); else await this.finishMove(file, op);
    }
  }
  async rebuildIndex() { return this.exclusive(() => this.rebuildIndexUnsafe()); }
  /** Internal adapter hook: callers already inside exclusive() may refresh the derived index. */
  async syncRefreshIndex() { return this.rebuildIndexUnsafe(); }
  /** Internal adapter hook used by WorkspaceSyncAdapter to retain the writer lock check. */
  syncWriteAtomically(relative: string, content: string | Uint8Array) { return this.writeAtomically(relative, content); }
  async syncRemove(relative: string, expectedHash?: string) {
    await this.assertWriterLock();
    const file = await safePath(this.root, relative);
    const bytes = await readSafe(this.root, relative).catch((error: any) => { if (error?.code === 'ENOENT') return undefined; throw error; });
    if (expectedHash && (!bytes || hash(bytes) !== expectedHash)) throw new AppError('同步资料在提交前发生变化，请重新同步', 409, 'CONFLICT');
    if (bytes) await fs.rm(file, { force: true });
  }
  private async updateIndexSafely() { try { await this.rebuildIndexUnsafe(); } catch { this.indexStatus = 'stale'; } }
  private async rebuildIndexUnsafe(items?: Entity[]) {
    const indexItems = items ?? await this.list(), file = await safePath(this.root, 'index/search.sqlite', true);
    this.database?.close(); this.database = undefined;
    try {
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(file);
        const check = database.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
        if (!check.every(row => row.quick_check === 'ok')) throw new AppError('检索索引损坏');
        database.exec('CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
      } catch (error) {
        try { database?.close(); } catch { /* best effort */ }
        const stat = await fs.lstat(file).catch(() => undefined);
        if (stat?.isDirectory() || stat?.isSymbolicLink()) throw error;
        await fs.rm(file, { force: true });
        database = new DatabaseSync(file); database.exec('CREATE TABLE documents (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
      }
      if (!database) throw new AppError('检索索引初始化失败');
      this.database = database;
      this.database.exec('BEGIN; DELETE FROM documents');
      const stmt = this.database.prepare('INSERT INTO documents(id,content) VALUES (?,?)');
      for (const e of indexItems) stmt.run(e.id, searchable(e));
      this.database.exec('COMMIT'); this.indexStatus = 'ready';
    } catch (error) {
      try { this.database?.close(); } catch { /* best effort */ }
      this.database = undefined; this.indexStatus = 'stale'; throw error;
    }
  }
  async search(query: string) {
    const items = await this.list(), normalized = query.normalize('NFC').trim().toLocaleLowerCase();
    if (!normalized) return items;
    if (!this.database || this.indexStatus !== 'ready') return items.filter(e => searchable(e).includes(normalized));
    try {
      const rows = this.database.prepare('SELECT id, content FROM documents').all() as { id: string; content: string }[];
      const indexed = new Map(rows.map(row => [row.id, row.content]));
      const ids = new Set(rows.filter(row => row.content.includes(normalized)).map(row => row.id));
      let changed = rows.length !== items.length;
      for (const entity of items) {
        const current = searchable(entity), stored = indexed.get(entity.id);
        if (stored !== current) { changed = true; if (current.includes(normalized)) ids.add(entity.id); else ids.delete(entity.id); }
      }
      if (changed) this.indexStatus = 'stale';
      return items.filter(entity => ids.has(entity.id) && searchable(entity).includes(normalized));
    } catch {
      this.indexStatus = 'stale';
      return items.filter(entity => searchable(entity).includes(normalized));
    }
  }
  async state(): Promise<WorkspaceState> {
    const entities = await this.list(); let storageBytes = 0;
    for (const file of await listFiles(this.root)) storageBytes += (await fs.stat(await safePath(this.root, file))).size;
    return { entities, readOnly: this.readOnly, indexStatus: this.indexStatus, dataDirectory: this.root, storageBytes, workspaceId: this.workspaceId, platformLabel: `${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform} · ${process.arch}`, ...(this.recoveryWarning ? { recoveryWarning: this.recoveryWarning } : {}) };
  }
}
