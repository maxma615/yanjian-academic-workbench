import { conflictId, bytesEqual, bytesHash, type SyncBytes, type SyncConflict, type SyncSnapshot } from './contracts';
import { sha256 } from './scope';

function manifest(id: string, path: string, remote: SyncBytes, sourceKind: 'entity' | 'tombstone' = 'entity', remoteRevision?: string): Uint8Array {
  const kind = path.match(/^(?:notes|logs|papers)\/([^/]+)(?:\/metadata\.json|\.md)$/);
  const type = path.startsWith('notes/') ? 'note' : path.startsWith('logs/') ? 'log' : 'paper';
  const entityId = type === 'paper' ? path.split('/')[1] : type === 'log' ? path.split('/')[2].split('.')[0] : path.split('/')[1].split('.')[0];
  return Buffer.from(JSON.stringify({ schemaVersion: 1, source: 'remote', sourceKind, ...(remoteRevision ? { remoteRevision } : {}), createdAt: new Date().toISOString(), entityType: type, entityId, originalRelativePath: path, contentHash: sha256(remote), conflictId: id }, null, 2) + '\n');
}

export interface ReconcileResult {
  snapshot: SyncSnapshot;
  conflicts: SyncConflict[];
  blocked: boolean;
}

export function reconcile(base: SyncSnapshot, local: SyncSnapshot, remote: SyncSnapshot, remoteRevision?: string): ReconcileResult {
  const merged = new Map<string, SyncBytes>();
  const conflicts: SyncConflict[] = [];
  const paths = new Set([...base.files.keys(), ...local.files.keys(), ...remote.files.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.files.get(path), l = local.files.get(path), r = remote.files.get(path);
    if (bytesEqual(l, r)) { if (l) merged.set(path, new Uint8Array(l)); continue; }
    if (bytesEqual(l, b)) { if (r) merged.set(path, new Uint8Array(r)); continue; }
    if (bytesEqual(r, b)) { if (l) merged.set(path, new Uint8Array(l)); continue; }
    if (l) merged.set(path, new Uint8Array(l));
    // A conflict's remote copy is deliberately kept outside the source path.
    // It is only published after an explicit resolution in a later batch.
    if (r) {
      const id = conflictId();
      const preservedPath = `conflicts/${id}/${path}`;
      const manifestPath = `conflicts/${id}/manifest.json`;
      merged.set(manifestPath, manifest(id, path, r, 'entity', remoteRevision));
      merged.set(preservedPath, new Uint8Array(r));
      conflicts.push({ id, path, local: l && new Uint8Array(l), remote: new Uint8Array(r), manifest: merged.get(manifestPath)!, preservedPath, remoteRevision });
    }
  }
  // A tombstone is the remote representation of deletion, so a tombstone and
  // a locally edited original are a conflict even though they have different
  // physical paths in the snapshot.
  for (const [tombstonePath, tombstone] of remote.files) {
    const match = /^tombstones\/(?:note|log|paper)\/[^/]+\.json$/.exec(tombstonePath);
    if (!match) continue;
    let originalPath: unknown;
    try { originalPath = JSON.parse(Buffer.from(tombstone).toString('utf8')).originalRelativePath; } catch { continue; }
    if (typeof originalPath !== 'string') continue;
    const b = base.files.get(originalPath), l = local.files.get(originalPath);
    if (l && !bytesEqual(l, b)) {
      const already = conflicts.some(conflict => conflict.path === originalPath);
      if (!already) {
        const id = conflictId();
        const manifestPath = `conflicts/${id}/manifest.json`;
        const preservedPath = `conflicts/${id}/${originalPath}`;
        merged.set(manifestPath, manifest(id, originalPath, tombstone, 'tombstone', remoteRevision));
        merged.set(preservedPath, new Uint8Array(tombstone));
        conflicts.push({ id, path: originalPath, local: new Uint8Array(l), remote: new Uint8Array(tombstone), manifest: merged.get(manifestPath)!, preservedPath, remoteRevision });
      }
    }
  }
  // The symmetric case can occur on first connection with an empty baseline:
  // a local tombstone and a remote primary file refer to the same entity even
  // though their physical paths differ. Treat it as deletion-vs-edit.
  for (const [tombstonePath, tombstone] of local.files) {
    if (!/^tombstones\/(?:note|log|paper)\/[^/]+\.json$/.test(tombstonePath)) continue;
    let originalPath: unknown;
    try { originalPath = JSON.parse(Buffer.from(tombstone).toString('utf8')).originalRelativePath; } catch { continue; }
    if (typeof originalPath !== 'string') continue;
    const b = base.files.get(originalPath), r = remote.files.get(originalPath);
    if (!r || bytesEqual(r, b) || conflicts.some(conflict => conflict.path === originalPath)) continue;
    const id = conflictId();
    const manifestPath = `conflicts/${id}/manifest.json`;
    const preservedPath = `conflicts/${id}/${originalPath}`;
    merged.delete(originalPath);
    merged.set(manifestPath, manifest(id, originalPath, r, 'entity', remote.revision));
    merged.set(preservedPath, new Uint8Array(r));
    conflicts.push({ id, path: originalPath, remote: new Uint8Array(r), manifest: merged.get(manifestPath)!, preservedPath, remoteRevision: remote.revision });
  }
  return { snapshot: { revision: remote.revision, files: merged }, conflicts, blocked: conflicts.length > 0 };
}

export function conflictSummary(conflict: SyncConflict) {
  return { id: conflict.id, path: conflict.path, localHash: bytesHash(conflict.local), remoteHash: bytesHash(conflict.remote), preservedPath: conflict.preservedPath };
}
