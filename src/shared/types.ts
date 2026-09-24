export type EntityType = 'task' | 'event' | 'paper' | 'note' | 'log';
export interface Attachment { id: string; name: string; path: string; sha256: string; size: number; available?: boolean }
export interface Entity {
  id: string; type: EntityType; schemaVersion: number; title: string;
  createdAt: string; updatedAt: string; revision: number;
  body?: string; date?: string; paperIds?: string[];
  authors?: string; year?: number; publication?: string; doi?: string; url?: string;
  tags?: string[]; readingStatus?: 'unread' | 'reading' | 'read'; attachments?: Attachment[];
  description?: string; dueDate?: string; priority?: 'low' | 'normal' | 'high';
  category?: string; completed?: boolean;
  start?: string; end?: string; allDay?: boolean; location?: string;
  [key: string]: unknown;
}
export type EntityInput = Partial<Entity> & { type: EntityType; title: string; expectedRevision?: number };
export interface WorkspaceState {
  entities: Entity[]; readOnly: boolean; indexStatus: 'ready' | 'stale';
  dataDirectory: string; storageBytes: number; workspaceId: string; platformLabel: string; recoveryWarning?: string;
}
export interface SaveResult { entity: Entity; savedAt: string; indexStatus: 'ready' | 'stale' }
export interface BackupManifest {
  schemaVersion: 1; createdAt: string;
  files: { path: string; byteSize: number; sha256: string }[];
}
