export interface SyncDestinationView { owner: string; repo: string; branch: string }
export interface SyncConflictView { id: string; path: string; localText?: string; remoteText?: string }
export interface SyncView {
  available: boolean;
  enabled: boolean;
  credentialCleanupPending?: boolean;
  destination?: SyncDestinationView;
  status: string;
  message: string;
  conflicts: SyncConflictView[];
}
