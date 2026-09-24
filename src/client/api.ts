import type { BackupManifest, Entity, EntityInput, SaveResult, WorkspaceState } from '../shared/types';
import type { SyncDestinationView, SyncView } from '../shared/sync-ui';

let token: string | null = null;

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (token && path !== '/api/session') headers.set('X-Workbench-Token', token);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    let code: string | undefined;
    try {
      const detail = await response.json() as { error?: string; code?: string };
      message = detail.error || message;
      code = detail.code;
    } catch { /* non-JSON response */ }
    throw new ApiError(message, response.status, code);
  }
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json() as Promise<T>;
  return response.blob() as Promise<T>;
}

export async function startSession(): Promise<void> {
  const result = await request<{ token: string }>('/api/session');
  token = result.token;
}

export function getState() { return request<WorkspaceState>('/api/state'); }
export function search(q: string) { return request<{ results: Entity[] }>(`/api/search?q=${encodeURIComponent(q)}`); }
export function createEntity(input: EntityInput) { return request<SaveResult>('/api/entities', { method: 'POST', body: JSON.stringify(input) }); }
export function updateEntity(id: string, fields: Partial<Entity>, expectedRevision: number) {
  return request<SaveResult>(`/api/entities/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ ...fields, expectedRevision }) });
}
export function deleteEntity(id: string, expectedRevision: number) {
  return request<{ ok: true }>(`/api/entities/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision }) });
}
export function importPdf(id: string, payload: { name: string; base64: string; expectedRevision: number }) {
  return request<SaveResult>(`/api/papers/${encodeURIComponent(id)}/pdf`, { method: 'POST', body: JSON.stringify(payload) });
}
export async function getPdf(id: string, attachmentId: string) {
  return request<Blob>(`/api/papers/${encodeURIComponent(id)}/pdf/${encodeURIComponent(attachmentId)}`);
}
export async function exportEntity(id: string) { return request<Blob>(`/api/entities/${encodeURIComponent(id)}/export`); }
export function rebuildIndex() { return request<{ ok: true }>('/api/index/rebuild', { method: 'POST' }); }
export async function createBackup() { return request<Blob>('/api/backup', { method: 'POST' }); }
export function inspectRestore(base64: string) { return request<{ manifest: BackupManifest }>('/api/restore/inspect', { method: 'POST', body: JSON.stringify({ base64 }) }); }
export function chooseRestoreTarget(path: string) { return request<{ token: string; displayPath: string }>('/api/restore/target', { method: 'POST', body: JSON.stringify({ path }) }); }
export function restore(base64: string, targetToken: string) { return request<{ dataDirectory: string; cleanupWarning?: string }>('/api/restore', { method: 'POST', body: JSON.stringify({ base64, targetToken }) }); }
export function syncStatus() { return request<SyncView>('/api/sync'); }
export function connectSync(destination: SyncDestinationView, token: string) { return request<SyncView>('/api/sync/connect', { method: 'POST', body: JSON.stringify({ destination, token, authorized: true }) }); }
export function runSync() { return request<SyncView>('/api/sync/run', { method: 'POST' }); }
export function disconnectSync() { return request<SyncView>('/api/sync/disconnect', { method: 'POST' }); }
export function resolveSync(id: string, choice: 'local' | 'remote' | 'edit', editedText?: string) { return request<SyncView>('/api/sync/resolve', { method: 'POST', body: JSON.stringify({ id, choice, editedText }) }); }

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
