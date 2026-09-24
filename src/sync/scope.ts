import { createHash } from 'node:crypto';
import { AppError } from '../../server/fs-safe';
import { isUuid, parseEntity } from '../../server/entities';
import type { SyncBytes, SyncEntityType, SyncSnapshot } from './contracts';

const HEX = /^[0-9a-f]{64}$/i;
const allowedTypes = new Set<SyncEntityType>(['note', 'log', 'paper']);
const text = (bytes: SyncBytes) => Buffer.from(bytes).toString('utf8');
const digest = (bytes: SyncBytes) => createHash('sha256').update(bytes).digest('hex');

function pathKind(path: string): { kind: 'main'; type: SyncEntityType; id: string } | { kind: 'tombstone'; type: string; id: string } | { kind: 'conflict-manifest'; id: string } | { kind: 'conflict-copy'; id: string; originalPath: string } | { kind: 'excluded' } | { kind: 'unknown' } {
  let match = /^notes\/([^/]+)\.md$/.exec(path);
  if (match) return { kind: 'main', type: 'note', id: match[1] };
  match = /^logs\/(\d{4})\/([^/]+)\.md$/.exec(path);
  if (match) return { kind: 'main', type: 'log', id: match[2] };
  match = /^papers\/([^/]+)\/metadata\.json$/.exec(path);
  if (match) return { kind: 'main', type: 'paper', id: match[1] };
  match = /^tombstones\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (match) return { kind: 'tombstone', type: match[1] as SyncEntityType, id: match[2] };
  match = /^conflicts\/([^/]+)\/manifest\.json$/.exec(path);
  if (match) return { kind: 'conflict-manifest', id: match[1] };
  match = /^conflicts\/([^/]+)\/(.+)$/.exec(path);
  if (match) return { kind: 'conflict-copy', id: match[1], originalPath: match[2] };
  if (/^(?:tasks|events|state|index|backups?|credentials|deletion-snapshots|workspace\.json)(?:\/|$)/.test(path) || /^.+\.pdf$/i.test(path)) return { kind: 'excluded' };
  return { kind: 'unknown' };
}

function fail(path: string, message: string): never { throw new AppError(`同步资料无效：${path}（${message}）`, 400, 'SYNC_SCOPE_INVALID'); }

function parseJson(bytes: SyncBytes, path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '必须是 JSON 对象');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(path, 'JSON 格式错误');
  }
}

function validateMain(path: string, bytes: SyncBytes, kind: Extract<ReturnType<typeof pathKind>, { kind: 'main' }>) {
  if (!isUuid(kind.id) || !allowedTypes.has(kind.type)) fail(path, '实体类型或 UUID 不符合允许范围');
  let entity;
  try { entity = parseEntity(text(bytes), path); } catch (error) { fail(path, error instanceof Error ? error.message : '实体格式错误'); }
  if (entity.id !== kind.id || entity.type !== kind.type) fail(path, '实体身份与路径不一致');
  if (kind.type === 'log' && path.slice(5, 9) !== entity.date?.slice(0, 4)) fail(path, '日志年份与日期不一致');
}

function validateTombstone(path: string, bytes: SyncBytes, kind: Extract<ReturnType<typeof pathKind>, { kind: 'tombstone' }>) {
  if (!allowedTypes.has(kind.type as SyncEntityType) || !isUuid(kind.id)) fail(path, '原实体类型或 UUID 不符合允许范围');
  const value = parseJson(bytes, path);
  if (value.schemaVersion !== 1 || value.entityType !== kind.type || value.entityId !== kind.id || typeof value.originalRelativePath !== 'string' || !HEX.test(String(value.contentHash))) fail(path, '墓碑字段无效');
  const original = pathKind(value.originalRelativePath);
  if (original.kind !== 'main' || original.type !== kind.type || original.id !== kind.id) fail(path, '墓碑原路径与身份不一致');
}

interface ConflictManifest { schemaVersion: 1; conflictId?: string; source: string; sourceKind?: 'entity' | 'tombstone'; remoteRevision?: string; createdAt: string; entityType: SyncEntityType; entityId: string; originalRelativePath: string; contentHash: string }

function validateConflict(path: string, bytes: SyncBytes, files: Map<string, SyncBytes>, id: string) {
  const value = parseJson(bytes, path) as Partial<ConflictManifest>;
  if (!isUuid(id) || (value.conflictId !== undefined && value.conflictId !== id) || value.schemaVersion !== 1 || typeof value.source !== 'string' || (value.remoteRevision !== undefined && typeof value.remoteRevision !== 'string') || typeof value.createdAt !== 'string' || !allowedTypes.has(value.entityType as SyncEntityType) || !isUuid(value.entityId) || typeof value.originalRelativePath !== 'string' || !HEX.test(String(value.contentHash))) fail(path, '冲突清单字段无效');
  const original = pathKind(value.originalRelativePath);
  if (original.kind !== 'main' || original.type !== value.entityType || original.id !== value.entityId) fail(path, '冲突原路径与实体身份不一致');
  const sourcePath = `conflicts/${id}/${value.originalRelativePath}`;
  const source = files.get(sourcePath);
  if (!source || digest(source) !== value.contentHash) fail(path, '冲突正文缺失或哈希不符');
  if (value.sourceKind === 'tombstone') {
    const tombstone = parseJson(source, sourcePath);
    if (tombstone.schemaVersion !== 1 || tombstone.entityType !== value.entityType || tombstone.entityId !== value.entityId || tombstone.originalRelativePath !== value.originalRelativePath || !HEX.test(String(tombstone.contentHash))) fail(path, '冲突墓碑正文身份无效');
  } else {
    // The conflict copy lives below conflicts/<id>/; parse the bytes against
    // their declared original path so parseEntity can verify entity identity.
    validateMain(value.originalRelativePath, source, original);
  }
  return value as ConflictManifest;
}

/**
 * Validate a complete snapshot. Local snapshots may contain ordinary workspace
 * files which are intentionally excluded; remote trees are strict and reject
 * every file outside the allow-list so a broad download filter cannot hide a
 * bad remote file.
 */
export function validateSnapshot(snapshot: SyncSnapshot, options: { remote: boolean }): SyncSnapshot {
  const files = new Map([...snapshot.files].map(([path, bytes]) => [path, new Uint8Array(bytes)]));
  const included = new Map<string, SyncBytes>();
  const manifests = new Map<string, SyncBytes>();
  const copies = new Map<string, { path: string; id: string }>();
  const excludedConflictIds = new Set<string>();
  const paperIds = new Set<string>();
  for (const [path, bytes] of files) {
    if (!path || path !== path.normalize('NFC') || path.includes('\\') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) fail(path, '路径不安全');
    const kind = pathKind(path);
    if (kind.kind === 'excluded') { if (options.remote) fail(path, '远端含有禁止同步资料'); continue; }
    if (kind.kind === 'unknown') fail(path, '未知同步路径');
    if (kind.kind === 'main') { validateMain(path, bytes, kind); included.set(path, bytes); if (kind.type === 'paper') paperIds.add(kind.id); }
    else if (kind.kind === 'tombstone') {
      if (kind.type === 'task' || kind.type === 'event') { if (options.remote) fail(path, '远端含有待办或日历墓碑'); continue; }
      if (!allowedTypes.has(kind.type as SyncEntityType)) fail(path, '墓碑原实体类型未知');
      validateTombstone(path, bytes, kind); included.set(path, bytes); if (kind.type === 'paper') paperIds.add(kind.id);
    }
    else if (kind.kind === 'conflict-manifest') {
      const manifest = parseJson(bytes, path);
      if (manifest.entityType === 'task' || manifest.entityType === 'event') { if (options.remote) fail(path, '远端含有待办或日历冲突副本'); excludedConflictIds.add(kind.id); continue; }
      if (!allowedTypes.has(manifest.entityType as SyncEntityType)) fail(path, '冲突原实体类型未知');
      manifests.set(kind.id, bytes); included.set(path, bytes);
    }
    else { copies.set(path, { path, id: kind.id }); included.set(path, bytes); }
  }
  for (const [id, bytes] of manifests) validateConflict(`conflicts/${id}/manifest.json`, bytes, files, id);
  for (const [path, copy] of copies) {
    if (excludedConflictIds.has(copy.id)) { included.delete(path); continue; }
    if (!manifests.has(copy.id)) fail(path, '冲突正文没有对应清单');
    const manifest = parseJson(manifests.get(copy.id)!, `conflicts/${copy.id}/manifest.json`);
    const expected = `conflicts/${copy.id}/${manifest.originalRelativePath}`;
    if (path !== expected) fail(path, '冲突正文路径与清单不一致');
  }
  for (const id of excludedConflictIds) for (const path of included.keys()) if (path.startsWith(`conflicts/${id}/`)) included.delete(path);
  for (const [path, bytes] of included) {
    const kind = pathKind(path);
    if (kind.kind !== 'main' || (kind.type !== 'note' && kind.type !== 'log')) continue;
    const entity = parseEntity(text(bytes), path);
    for (const paperId of entity.paperIds ?? []) if (!paperIds.has(paperId)) fail(path, '关联文献不存在，或不是文献墓碑');
  }
  return { revision: snapshot.revision, files: included };
}

export function selectLocalSyncFiles(snapshot: SyncSnapshot): SyncSnapshot {
  return validateSnapshot(snapshot, { remote: false });
}

export const sha256 = digest;
