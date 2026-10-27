export interface SyncDestinationView { owner: string; repo: string; branch: string }
export interface SyncConflictView { id: string; path: string; localText?: string; remoteText?: string }
export interface SyncView {
  /** This host exposes credential storage; OS authorization is checked on connection. */
  available: boolean;
  enabled: boolean;
  credentialCleanupPending?: boolean;
  destination?: SyncDestinationView;
  status: string;
  message: string;
  conflicts: SyncConflictView[];
}
