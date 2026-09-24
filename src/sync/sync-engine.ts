import { randomUUID } from 'node:crypto';
import { AppError } from '../../server/fs-safe';
import { entityPath, parseEntity, serializeEntity } from '../../server/entities';
import { reconcile } from './reconcile';
import { selectLocalSyncFiles, validateSnapshot } from './scope';
import { bytesEqual, cloneSnapshot, snapshotFingerprint, type CredentialProvider, type SyncBaseline, type SyncResult, type SyncTransport, type SyncWorkspaceAdapter } from './contracts';

export interface SyncEngineOptions {
  enabled?: boolean;
  workspace: SyncWorkspaceAdapter;
  transport?: SyncTransport;
  credentials?: CredentialProvider;
}

function restoreAsNew(originalPath: string, bytes: Uint8Array): { path: string; bytes: Uint8Array } {
  const entity = parseEntity(Buffer.from(bytes).toString('utf8'), originalPath);
  const now = new Date().toISOString();
  const restored = { ...entity, id: randomUUID(), createdAt: now, updatedAt: now, revision: 1 };
  if (restored.type === 'paper' && restored.attachments) restored.attachments = restored.attachments.map(attachment => ({ ...attachment, path: attachment.path.replace(`papers/${entity.id}/`, `papers/${restored.id}/`) }));
  return { path: entityPath(restored), bytes: Buffer.from(serializeEntity(restored)) };
}
function bumpResolvedRevision(originalPath: string, selected: Uint8Array, candidates: Array<Uint8Array | undefined>): Uint8Array {
  const entity = parseEntity(Buffer.from(selected).toString('utf8'), originalPath);
  let revision = entity.revision;
  for (const candidate of candidates) if (candidate) { try { revision = Math.max(revision, parseEntity(Buffer.from(candidate).toString('utf8'), originalPath).revision); } catch { /* tombstone or an absent side */ } }
  return Buffer.from(serializeEntity({ ...entity, revision: revision + 1, updatedAt: new Date().toISOString() }));
}

export class SyncEngine {
  private enabled: boolean;
  constructor(private readonly options: SyncEngineOptions) { this.enabled = options.enabled === true; }
  isEnabled() { return this.enabled; }
  enable() { this.enabled = true; }
  async disable() { this.enabled = false; await this.options.credentials?.clear?.(); }
  /** Apply an explicit user choice while retaining the conflict directory until this write succeeds. */
  async resolveConflict(conflictId: string, choice: 'local' | 'remote' | 'edit', edited?: Uint8Array): Promise<void> {
    const current = selectLocalSyncFiles(await this.options.workspace.readSyncSnapshot());
    const expectedFingerprint = snapshotFingerprint(current);
    const manifestPath = `conflicts/${conflictId}/manifest.json`;
    const manifestBytes = current.files.get(manifestPath);
    if (!manifestBytes) throw new AppError('找不到待处理的同步冲突', 404, 'SYNC_CONFLICT_NOT_FOUND');
    let manifest: any;
    try { manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')); } catch { throw new AppError('同步冲突清单损坏', 400, 'SYNC_SCOPE_INVALID'); }
    const sourcePath = `conflicts/${conflictId}/${manifest.originalRelativePath}`;
    const remote = current.files.get(sourcePath);
    const localOriginal = current.files.get(manifest.originalRelativePath);
    const localTombstone = [...current.files.entries()].find(([candidate, bytes]) => candidate.startsWith('tombstones/') && candidate.endsWith('.json') && (() => { try { return (JSON.parse(Buffer.from(bytes).toString()) as { originalRelativePath?: string }).originalRelativePath === manifest.originalRelativePath; } catch { return false; } })());
    let remoteTombstone: { path: string; originalRelativePath?: string } | undefined;
    if (remote) {
      try {
        const parsed = JSON.parse(Buffer.from(remote).toString('utf8')) as { entityType?: string; originalRelativePath?: string };
        if (parsed.entityType && parsed.originalRelativePath === manifest.originalRelativePath) {
          const path = [...current.files.keys()].find(candidate => {
            if (!candidate.startsWith('tombstones/') || !candidate.endsWith('.json')) return false;
            try { return (JSON.parse(Buffer.from(current.files.get(candidate)!).toString('utf8')) as { originalRelativePath?: string }).originalRelativePath === manifest.originalRelativePath; } catch { return false; }
          });
          if (path) remoteTombstone = { path, originalRelativePath: parsed.originalRelativePath };
        }
      } catch { /* ordinary remote text */ }
    }
    const remoteDeleted = manifest.sourceKind === 'tombstone' || Boolean(remoteTombstone);
    const localDeleted = !localOriginal && Boolean(localTombstone);
    let selected: Uint8Array | undefined;
    if (choice === 'remote') {
      if (!remote) throw new AppError('同步冲突远端副本缺失', 400, 'SYNC_SCOPE_INVALID');
      if (!remoteDeleted) selected = new Uint8Array(remote);
    } else if (choice === 'edit') {
      if (!edited) throw new AppError('编辑后的冲突内容不能为空');
      selected = new Uint8Array(edited);
    } else {
      selected = localOriginal ? new Uint8Array(localOriginal) : undefined;
    }
    current.files.delete(manifest.originalRelativePath);
    if (selected) {
      if (remoteDeleted || localDeleted) {
        const restored = restoreAsNew(manifest.originalRelativePath, selected);
        current.files.set(restored.path, restored.bytes);
      } else current.files.set(manifest.originalRelativePath, bumpResolvedRevision(manifest.originalRelativePath, selected, [localOriginal, remote]));
    }
    const evidence = new Map<string, Uint8Array>([
      [manifestPath, new Uint8Array(manifestBytes)],
      ...(remote ? [[sourcePath, new Uint8Array(remote)] as const] : []),
      ...(localOriginal ? [[`conflicts/${conflictId}/local/${manifest.originalRelativePath}`, new Uint8Array(localOriginal)] as const] : []),
    ]);
    await this.options.workspace.archiveSyncConflict?.(conflictId, evidence);
    for (const path of [...current.files.keys()]) if (path === manifestPath || path === sourcePath) current.files.delete(path);
    await this.options.workspace.applySyncSnapshot(current, expectedFingerprint);
    if (this.options.workspace.recordSyncResolution && manifest.remoteRevision) await this.options.workspace.recordSyncResolution(manifest.originalRelativePath, { remoteRevision: manifest.remoteRevision, ...(remote ? { remote: new Uint8Array(remote) } : {}) });
  }
  async syncNow(): Promise<SyncResult> {
    if (!this.enabled) return { status: 'disabled', conflicts: [], applied: false, message: 'GitHub 同步未启用；本地资料保持可用' };
    if (!this.options.transport) throw new AppError('同步尚未连接私人仓库', 409, 'SYNC_NOT_CONNECTED');
    const local = selectLocalSyncFiles(await this.options.workspace.readSyncSnapshot());
    const pending = [...local.files.entries()].filter(([path]) => /^conflicts\/[^/]+\/manifest\.json$/.test(path));
    if (pending.length) {
      const conflicts = pending.map(([path, bytes]) => {
        const id = path.split('/')[1];
        const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as { originalRelativePath: string; remoteRevision?: string };
        const preservedPath = `conflicts/${id}/${manifest.originalRelativePath}`;
        return { id, path: manifest.originalRelativePath, local: local.files.get(manifest.originalRelativePath), remote: local.files.get(preservedPath), manifest: bytes, preservedPath, remoteRevision: manifest.remoteRevision };
      });
      return { status: 'conflict', conflicts, applied: false, message: `有 ${conflicts.length} 项冲突尚未处理` };
    }
    const remote = validateSnapshot(await this.options.transport.readSnapshot(), { remote: true });
    const baseline = await this.options.workspace.readSyncBaseline();
    const base = baseline ? { revision: baseline.revision, files: new Map(baseline.files) } : { files: new Map() };
    const resolutions = await this.options.workspace.readSyncResolutions?.() ?? new Map();
    if (remote.revision) for (const [path, resolution] of resolutions) if (resolution.remoteRevision === remote.revision && bytesEqual(remote.files.get(path), resolution.remote)) {
      if (resolution.remote === undefined) base.files.delete(path); else base.files.set(path, new Uint8Array(resolution.remote));
    }
    const merged = reconcile(base, local, remote, remote.revision);
    if (merged.conflicts.length) {
      await this.options.workspace.applySyncSnapshot(merged.snapshot, snapshotFingerprint(local));
      return { status: 'conflict', conflicts: merged.conflicts, applied: true, message: `有 ${merged.conflicts.length} 项双边修改，需要处理冲突` };
    }
    await this.options.workspace.applySyncSnapshot(merged.snapshot, snapshotFingerprint(local));
    let published;
    try { published = await this.options.transport.publish(merged.snapshot.files, remote.revision); }
    catch (error: any) {
      if (error?.code === 'REMOTE_CHANGED' || error?.status === 409) return { status: 'remote-changed', conflicts: [], applied: true, message: '远端在发布前发生变化；本地资料未回滚，请重新同步' };
      return { status: 'failed', conflicts: [], applied: true, message: error instanceof Error ? error.message : '同步发布失败；本地资料已保留' };
    }
    const next: SyncBaseline = { schemaVersion: 1, revision: published.revision, files: cloneSnapshot(merged.snapshot).files };
    await this.options.workspace.writeSyncBaseline(next);
    await this.options.workspace.clearSyncResolutions?.();
    return { status: 'synced', revision: published.revision, conflicts: [], applied: true, message: '同步完成，本地资料与私人仓库基线已更新' };
  }
}
