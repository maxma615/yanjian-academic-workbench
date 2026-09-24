import { createHash, randomUUID } from 'node:crypto';

export type SyncEntityType = 'note' | 'log' | 'paper';
export type SyncBytes = Uint8Array;

export interface SyncSnapshot {
  files: Map<string, SyncBytes>;
  /** The transport's optimistic-concurrency revision (a Git commit SHA for GitHub). */
  revision?: string;
}

export interface SyncDestination {
  owner: string;
  repo: string;
  branch: string;
}

export interface SyncTransport {
  readonly destination?: SyncDestination;
  readSnapshot(): Promise<SyncSnapshot>;
  publish(files: Map<string, SyncBytes>, expectedRevision?: string): Promise<{ revision: string }>;
}

export interface CredentialProvider {
  getToken(): Promise<string | undefined>;
  setToken?(token: string): Promise<void>;
  clear?(): Promise<void>;
}

export interface SyncBaseline {
  schemaVersion: 1;
  revision?: string;
  files: Map<string, SyncBytes>;
}

export interface SyncWorkspaceAdapter {
  readSyncSnapshot(): Promise<SyncSnapshot>;
  applySyncSnapshot(snapshot: SyncSnapshot, expectedFingerprint: string): Promise<void>;
  readSyncBaseline(): Promise<SyncBaseline | undefined>;
  writeSyncBaseline(baseline: SyncBaseline): Promise<void>;
  /** Move resolved conflict evidence into a full-backup-only area before cleanup. */
  archiveSyncConflict?(conflictId: string, files: Map<string, SyncBytes>): Promise<void>;
  readSyncResolutions?(): Promise<Map<string, { remoteRevision?: string; remote?: SyncBytes }>>;
  recordSyncResolution?(path: string, resolution: { remoteRevision?: string; remote?: SyncBytes }): Promise<void>;
  clearSyncResolutions?(paths?: string[]): Promise<void>;
}

export type SyncStatus = 'disabled' | 'connected' | 'synced' | 'conflict' | 'remote-changed' | 'failed';

export interface SyncConflict {
  id: string;
  path: string;
  local?: SyncBytes;
  remote?: SyncBytes;
  manifest: Uint8Array;
  preservedPath: string;
  remoteRevision?: string;
}

export interface SyncResult {
  status: SyncStatus;
  revision?: string;
  conflicts: SyncConflict[];
  applied: boolean;
  message: string;
}

export const bytesEqual = (left: SyncBytes | undefined, right: SyncBytes | undefined) => {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

export const bytesHash = (bytes: SyncBytes | undefined) =>
  bytes === undefined ? undefined : createHash('sha256').update(bytes).digest('hex');

export function snapshotFingerprint(snapshot: SyncSnapshot): string {
  const hash = createHash('sha256');
  for (const path of [...snapshot.files.keys()].sort()) {
    hash.update(path).update('\0').update(snapshot.files.get(path)!).update('\0');
  }
  return hash.digest('hex');
}

export function cloneSnapshot(snapshot: SyncSnapshot): SyncSnapshot {
  return {
    revision: snapshot.revision,
    files: new Map([...snapshot.files].map(([path, bytes]) => [path, new Uint8Array(bytes)])),
  };
}

export function cloneBaseline(baseline: SyncBaseline): SyncBaseline {
  return { schemaVersion: 1, revision: baseline.revision, files: cloneSnapshot(baseline).files };
}

export function conflictId() { return randomUUID(); }
