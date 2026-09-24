/**
 * The only renderer-facing native API.  Renderer code receives opaque tokens
 * and small result objects; filesystem paths and archive bytes stay in the
 * Electron main process.
 */

export type DesktopCanceled = { canceled: true };

export type DesktopSuccess<T extends object = Record<string, never>> =
  { canceled: false } & T;

export type DesktopResult<T extends object = Record<string, never>> =
  | DesktopCanceled
  | DesktopSuccess<T>;

export type DesktopAttachment = {
  id: string;
  name: string;
  revision: number;
};

export type DesktopManifest = {
  schemaVersion: 1;
  createdAt: string;
  files: Array<{ path: string; byteSize: number; sha256: string }>;
};

export type AcademicDesktopBridge = {
  importPdf(id: string, revision: number): Promise<DesktopResult<{ attachment: DesktopAttachment }>>;
  openPdf(id: string, attachmentId: string): Promise<DesktopResult<{ openedPath: string }>>;
  exportPdf(id: string, attachmentId: string): Promise<DesktopResult<{ path: string; byteSize: number }>>;
  exportEntity(id: string): Promise<DesktopResult<{ path: string; byteSize: number }>>;
  backup(): Promise<DesktopResult<{ path: string; byteSize: number; manifest: DesktopManifest }>>;
  chooseRestoreArchive(): Promise<DesktopResult<{ archiveToken: string; manifest: DesktopManifest }>>;
  chooseRestoreTarget(): Promise<DesktopResult<{ targetToken: string; displayPath: string }>>;
  restore(archiveToken: string, targetToken: string): Promise<DesktopResult<{ dataDirectory: string; cleanupWarning?: string }>>;
};

declare global {
  interface Window {
    academicDesktop?: AcademicDesktopBridge;
  }
}
