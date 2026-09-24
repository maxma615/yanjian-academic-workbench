import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createBackup } from '../../src/backup/backup-service';
import { NativeService, type FileDialogPort } from '../../electron/native-service';
import { isTrustedIpcSender } from '../../electron/ipc-security';
import type { Entity, SaveResult } from '../../src/shared/types';

const paperId = randomUUID();
const attachmentId = randomUUID();
const pdf = new TextEncoder().encode('%PDF-1.4\nfixture bytes\n%%EOF\n');

type DialogQueues = {
  files: Array<{ canceled: true } | { canceled: false; path: string }>;
  directories: Array<{ canceled: true } | { canceled: false; path: string }>;
  saves: Array<{ canceled: true } | { canceled: false; path: string; overwriteConfirmed: boolean }>;
};

class FixtureWorkspace {
  constructor(public readonly root: string) {}
  paper: Entity = {
    id: paperId,
    type: 'paper',
    schemaVersion: 1,
    title: 'Fixture paper',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 3,
    attachments: [{ id: attachmentId, name: '原始.pdf', path: `papers/${paperId}/attachments/${attachmentId}.pdf`, sha256: 'unused', size: pdf.byteLength, available: true }],
  };
  async get(id: string) { if (id !== paperId) throw new Error('missing'); return this.paper; }
  async importPdf(_id: string, name: string, bytes: Uint8Array, revision: number): Promise<SaveResult> {
    this.paper = { ...this.paper, revision: revision + 1, attachments: [{ id: attachmentId, name, path: `papers/${paperId}/attachments/${attachmentId}.pdf`, sha256: 'unused', size: bytes.byteLength, available: true }] };
    return { entity: this.paper, savedAt: new Date().toISOString(), indexStatus: 'ready' };
  }
  async readAttachment(id: string, id2: string) { if (id !== paperId || id2 !== attachmentId) throw new Error('missing'); return { bytes: pdf, name: '原始.pdf' }; }
  async exportEntity(id: string) { if (id !== paperId) throw new Error('missing'); return { bytes: new TextEncoder().encode('{"title":"fixture"}\n'), name: 'Fixture paper.json' }; }
  async exclusive<T>(work: () => Promise<T>) { return work(); }
}

async function fixture(): Promise<{ root: string; source: string; target: string; workspace: FixtureWorkspace; dialogs: DialogQueues; opened: string[]; service: NativeService }> {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.test-data/desktop-'));
  const source = path.join(root, 'source.pdf');
  const target = path.join(root, 'target');
  await fs.mkdir(path.join(root, 'workspace'), { recursive: true });
  await fs.mkdir(target);
  await fs.writeFile(source, pdf);
  await fs.writeFile(path.join(root, 'workspace', 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString() }));
  await fs.writeFile(path.join(root, 'workspace', 'notes.md'), 'fixture');
  const workspace = new FixtureWorkspace(path.join(root, 'workspace'));
  await fs.mkdir(path.join(workspace.root, 'papers', paperId, 'attachments'), { recursive: true });
  await fs.writeFile(path.join(workspace.root, 'papers', paperId, 'attachments', `${attachmentId}.pdf`), pdf);
  const dialogs: DialogQueues = { files: [], directories: [], saves: [] };
  const opened: string[] = [];
  const dialogPort: FileDialogPort = {
    openFile: async () => dialogs.files.shift() ?? { canceled: true },
    openDirectory: async () => dialogs.directories.shift() ?? { canceled: true },
    saveFile: async () => dialogs.saves.shift() ?? { canceled: true },
  };
  const service = new NativeService({
    dialogs: dialogPort,
    shell: { openPath: async filePath => { opened.push(filePath); return ''; } },
    runWithWorkspace: work => work(workspace),
    restore: {
      selectRestoreTarget: async selected => ({ token: `target:${selected}`, displayPath: selected }),
      restoreBackup: async (bytes, token) => ({ dataDirectory: `${token}:${bytes.byteLength}` }),
    },
  });
  return { root, source, target, workspace, dialogs, opened, service };
}

describe('Electron native platform service', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await fs.rm(f.root, { recursive: true, force: true }); });

  it('keeps cancellation side-effect free and imports a selected PDF through the workspace boundary', async () => {
    f.dialogs.files.push({ canceled: true });
    expect(await f.service.importPdf(paperId, 3)).toEqual({ canceled: true });
    f.dialogs.files.push({ canceled: false, path: f.source });
    const result = await f.service.importPdf(paperId, 3);
    expect(result.canceled).toBe(false);
    if (!result.canceled) expect(result.attachment.revision).toBe(4);
  });

  it('exports exact bytes atomically and refuses an unconfirmed overwrite or hard link', async () => {
    const output = path.join(f.root, 'export.md');
    await fs.writeFile(output, 'old');
    f.dialogs.saves.push({ canceled: false, path: output, overwriteConfirmed: false });
    await expect(f.service.exportEntity(paperId)).rejects.toThrow('覆盖');
    f.dialogs.saves.push({ canceled: false, path: output, overwriteConfirmed: true });
    const result = await f.service.exportEntity(paperId);
    expect(result).toMatchObject({ canceled: false, byteSize: 20 });
    expect(await fs.readFile(output, 'utf8')).toBe('{"title":"fixture"}\n');

    const linked = path.join(f.root, 'linked.md');
    const original = path.join(f.root, 'original.md');
    await fs.writeFile(original, 'keep');
    await fs.link(original, linked);
    f.dialogs.saves.push({ canceled: false, path: linked, overwriteConfirmed: true });
    await expect(f.service.exportEntity(paperId)).rejects.toThrow('独立文件');
    expect(await fs.readFile(original, 'utf8')).toBe('keep');
  });

  it('verifies a PDF before handing its managed path to the system shell and exports exact PDF bytes', async () => {
    const opened = await f.service.openPdf(paperId, attachmentId);
    expect(opened).toMatchObject({ canceled: false, openedPath: expect.stringContaining(`${attachmentId}.pdf`) });
    expect(f.opened).toHaveLength(1);
    const output = path.join(f.root, 'exported.pdf');
    f.dialogs.saves.push({ canceled: false, path: output, overwriteConfirmed: false });
    const exported = await f.service.exportPdf(paperId, attachmentId);
    expect(exported).toMatchObject({ canceled: false, byteSize: pdf.byteLength });
    expect(new Uint8Array(await fs.readFile(output))).toEqual(pdf);
  });

  it('keeps backup bytes in an opaque main-process token and consumes it once', async () => {
    const archive = await createBackup(f.workspace.root);
    const archivePath = path.join(f.root, 'fixture.zip');
    await fs.writeFile(archivePath, archive);
    f.dialogs.files.push({ canceled: false, path: archivePath });
    const selected = await f.service.chooseRestoreArchive();
    expect(selected.canceled).toBe(false);
    if (selected.canceled) return;
    expect(selected.archiveToken).not.toContain(path.sep);
    f.dialogs.directories.push({ canceled: false, path: f.target });
    expect(await f.service.chooseRestoreTarget()).toEqual({ canceled: false, targetToken: `target:${f.target}`, displayPath: f.target });
    expect(await f.service.restore(selected.archiveToken, `target:${f.target}`)).toMatchObject({ canceled: false, dataDirectory: expect.stringContaining(`${archive.byteLength}`) });
    await expect(f.service.restore(selected.archiveToken, `target:${f.target}`)).rejects.toThrow('过期');
  });

  it('rejects malformed or foreign IPC senders', () => {
    expect(isTrustedIpcSender({ sender: { id: 1 }, senderFrame: { url: 'http://127.0.0.1:5178/' } }, 1, 'http://127.0.0.1:5178')).toBe(true);
    expect(isTrustedIpcSender({ sender: { id: 2 }, senderFrame: { url: 'http://127.0.0.1:5178/' } }, 1, 'http://127.0.0.1:5178')).toBe(false);
    expect(isTrustedIpcSender({ sender: { id: 1 }, senderFrame: { url: 'https://evil.example/' } }, 1, 'http://127.0.0.1:5178')).toBe(false);
    expect(isTrustedIpcSender({ sender: { id: 1 }, senderFrame: { url: 'file:///tmp/renderer.html' } }, 1, 'http://127.0.0.1:5178')).toBe(false);
  });
});
