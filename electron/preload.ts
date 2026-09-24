import { contextBridge, ipcRenderer } from 'electron';
import type { AcademicDesktopBridge } from '../src/shared/desktop';

const bridge: AcademicDesktopBridge = {
  importPdf: (id, revision) => ipcRenderer.invoke('desktop:import-pdf', id, revision),
  openPdf: (id, attachmentId) => ipcRenderer.invoke('desktop:open-pdf', id, attachmentId),
  exportPdf: (id, attachmentId) => ipcRenderer.invoke('desktop:export-pdf', id, attachmentId),
  exportEntity: id => ipcRenderer.invoke('desktop:export-entity', id),
  backup: () => ipcRenderer.invoke('desktop:backup'),
  chooseRestoreArchive: () => ipcRenderer.invoke('desktop:choose-restore-archive'),
  chooseRestoreTarget: () => ipcRenderer.invoke('desktop:choose-restore-target'),
  restore: (archiveToken, targetToken) => ipcRenderer.invoke('desktop:restore', archiveToken, targetToken),
};

contextBridge.exposeInMainWorld('academicDesktop', bridge);

