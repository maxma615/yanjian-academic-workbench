import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createBackup, verifyBackup } from '../backup/backup-service';
import type { BackupManifest } from '../shared/types';

export type WorkspaceInspection = { schemaVersion: number; supported: boolean; readOnly: boolean };
export type MigrationConverter = (value: unknown, context: { filePath: string; fromVersion: number; toVersion: number }) => unknown | Promise<unknown>;
export type MigrationOptions = { currentVersion?: number; converters?: Record<number, MigrationConverter>; createBackup?: (root: string) => Promise<Uint8Array> };

async function copyTree(source: string, target: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`migration refuses symbolic link: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const entry of await fs.readdir(source)) await copyTree(path.join(source, entry), path.join(target, entry));
  } else if (stat.isFile()) {
    if (stat.nlink > 1) throw new Error(`migration refuses hard link: ${source}`);
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  }
}

async function migrationFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(current: string, relative: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`migration refuses symbolic link: ${full}`);
      if (entry.isDirectory()) {
        if (!['state', 'index', 'cache', 'credentials'].includes(rel.split('/')[0])) await walk(full, rel);
      } else if (entry.isFile() && (entry.name.endsWith('.json') || (entry.name.endsWith('.md') && (rel.startsWith('notes/') || rel.startsWith('logs/'))))) output.push(full);
    }
  }
  await walk(root, ''); return output;
}

function journalPath(root: string): string { return path.join(path.dirname(root), `.${path.basename(root)}.migration-journal.json`); }
function lockPath(root: string): string { return path.join(path.dirname(root), `.${path.basename(root)}.migration-lock`); }
async function exists(file: string): Promise<boolean> { try { await fs.lstat(file); return true; } catch { return false; } }
async function writeDurable(file: string, bytes: Uint8Array | string, flag: 'wx' | 'w' = 'w'): Promise<void> {
  const handle = await fs.open(file, flag, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function isDirectOperationPath(root: string, candidate: string, marker: 'migration' | 'before', operationId: string): boolean {
  const parent = path.dirname(root), base = path.basename(root), resolved = path.resolve(candidate);
  return path.dirname(resolved) === parent && path.basename(resolved) === `.${base}.${marker}-${operationId}`;
}
function isBackupOperationPath(root: string, candidate: string, operationId: string): boolean {
  const expected = path.join(path.dirname(root), '.academic-workbench-migrations', path.basename(root));
  const resolved = path.resolve(candidate);
  return path.dirname(resolved) === expected && path.basename(resolved) === `${operationId}.before.zip`;
}
function isPidAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
async function acquireMigrationLock(file: string): Promise<void> {
  const record = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try { await writeDurable(file, record, 'wx'); return; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let previous: { pid?: unknown };
  try { previous = JSON.parse(await fs.readFile(file, 'utf8')) as { pid?: unknown }; } catch { throw new Error('migration lock is active or corrupt'); }
  if (isPidAlive(previous.pid)) throw new Error('migration is already active');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('migration lock is not managed');
  await fs.unlink(file);
  await writeDurable(file, record, 'wx');
}
async function recoverPending(root: string): Promise<void> {
  const journal = journalPath(root); if (!(await exists(journal))) return;
  let operation: { root?: string; stage?: string; displaced?: string; backupPath?: string; toVersion?: number; operationId?: string; afterFiles?: BackupManifest['files'] };
  try { operation = JSON.parse(await fs.readFile(journal, 'utf8')) as { stage: string; displaced: string }; } catch { throw new Error('migration recovery journal is invalid'); }
  if (operation.root !== root || !operation.operationId || !/^[0-9a-f]{16}$/.test(operation.operationId) || !operation.stage || !operation.displaced || !operation.backupPath || !isDirectOperationPath(root, operation.stage, 'migration', operation.operationId) || !isDirectOperationPath(root, operation.displaced, 'before', operation.operationId) || !isBackupOperationPath(root, operation.backupPath, operation.operationId)) throw new Error('migration recovery journal is outside the managed workspace');
  const managedParent = await fs.realpath(path.dirname(root));
  if (await fs.realpath(path.dirname(operation.stage)) !== managedParent || await fs.realpath(path.dirname(operation.displaced)) !== managedParent || await fs.realpath(path.dirname(operation.backupPath)) !== await fs.realpath(path.join(path.dirname(root), '.academic-workbench-migrations', path.basename(root)))) throw new Error('migration recovery journal parent identity changed');
  const backupStat = await fs.lstat(operation.backupPath).catch(() => undefined);
  if (!backupStat || !backupStat.isFile() || backupStat.isSymbolicLink() || backupStat.nlink > 1) throw new Error('migration recovery backup is not managed');
  const persistedBackup = new Uint8Array(await fs.readFile(operation.backupPath));
  verifyBackup(persistedBackup);
  if (!(await exists(root)) && await exists(operation.stage) && !(await exists(operation.displaced))) {
    const stageStat = await fs.lstat(operation.stage);
    if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) throw new Error('migration recovery stage is not a managed directory');
    const stageSchema = (JSON.parse(await fs.readFile(path.join(operation.stage, 'workspace.json'), 'utf8')) as { schemaVersion?: unknown }).schemaVersion;
    if (stageSchema !== operation.toVersion) throw new Error('migration recovery stage has an unexpected version');
    await fs.rename(operation.stage, root); verifyBackup(await createBackup(root)); await fs.rm(journal, { force: true }); return;
  }
  if (!(await exists(root)) && await exists(operation.displaced)) {
    const displacedStat = await fs.lstat(operation.displaced);
    if (!displacedStat.isDirectory() || displacedStat.isSymbolicLink()) throw new Error('migration recovery predecessor is not a managed directory');
    await fs.rename(operation.displaced, root);
    if (!sameBackupFiles(persistedBackup, await createBackup(root))) throw new Error('migration recovery predecessor checksum changed');
    await fs.rm(operation.stage, { recursive: true, force: true }); await fs.rm(journal, { force: true }); return;
  }
  if (await exists(root) && await exists(operation.stage)) await fs.rm(operation.stage, { recursive: true, force: true });
  if (await exists(root) && await exists(operation.displaced)) {
    let schema: unknown;
    try { schema = (JSON.parse(await fs.readFile(path.join(root, 'workspace.json'), 'utf8')) as { schemaVersion?: unknown }).schemaVersion; } catch { throw new Error('migration recovery found an invalid active workspace'); }
    if (schema !== operation.toVersion) throw new Error('migration recovery found ambiguous active and displaced workspaces');
    const currentFiles = verifyBackup(await createBackup(root)).manifest.files;
    if (!operation.afterFiles || JSON.stringify(currentFiles) !== JSON.stringify(operation.afterFiles)) throw new Error('migration recovery cannot verify the activated files; predecessor has been preserved');
    await fs.rm(operation.displaced, { recursive: true, force: true });
  }
  await fs.rm(journal, { force: true });
}
function sameBackupFiles(a: Uint8Array, b: Uint8Array): boolean {
  const left = verifyBackup(a).manifest.files, right = verifyBackup(b).manifest.files;
  return left.length === right.length && left.every((file, index) => file.path === right[index].path && file.byteSize === right[index].byteSize && file.sha256 === right[index].sha256);
}

export class MigrationService {
  private readonly currentVersion: number;
  private readonly converters: Record<number, MigrationConverter>;
  private readonly backup: (root: string) => Promise<Uint8Array>;
  constructor(options: MigrationOptions = {}) {
    this.currentVersion = options.currentVersion ?? 1;
    this.converters = options.converters ?? {};
    this.backup = options.createBackup ?? createBackup;
  }

  async inspect(root: string): Promise<WorkspaceInspection> {
    const workspacePath = path.join(path.resolve(root), 'workspace.json');
    let parsed: unknown;
    try { parsed = JSON.parse(await fs.readFile(workspacePath, 'utf8')); } catch { throw new Error('workspace.json is invalid'); }
    const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
    if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 1) throw new Error('workspace schemaVersion is invalid');
    const supported = (schemaVersion as number) <= this.currentVersion;
    return { schemaVersion: schemaVersion as number, supported, readOnly: !supported };
  }

  async migrate(root: string, targetVersion = this.currentVersion): Promise<{ schemaVersion: number; backup: Uint8Array; backupPath?: string; cleanupWarning?: string }> {
    const sourceRoot = path.resolve(root);
    const lock = lockPath(sourceRoot);
    await acquireMigrationLock(lock);
    try {
      if (await exists(path.join(sourceRoot, 'state', 'writer.lock'))) throw new Error('workspace is active; migration requires an offline workspace');
      await recoverPending(sourceRoot);
      if (await exists(path.join(sourceRoot, 'state', 'writer.lock'))) throw new Error('workspace is active; migration requires an offline workspace');
      const inspected = await this.inspect(sourceRoot);
      if (!inspected.supported) throw new Error(`unsupported workspace version ${inspected.schemaVersion}; read-only`);
      if (!Number.isSafeInteger(targetVersion) || targetVersion < inspected.schemaVersion || targetVersion > this.currentVersion) throw new Error('invalid target schema version');
      if (targetVersion === inspected.schemaVersion) {
        const backup = await this.backup(sourceRoot); verifyBackup(backup);
        return { schemaVersion: targetVersion, backup };
      }
      for (let version = inspected.schemaVersion; version < targetVersion; version++) if (!this.converters[version]) throw new Error(`no migration converter for version ${version}`);
      const backup = await this.backup(sourceRoot); verifyBackup(backup);
    const parent = path.dirname(sourceRoot), operationId = randomBytes(8).toString('hex');
    const stage = path.join(parent, `.${path.basename(sourceRoot)}.migration-${operationId}`);
    const backupPath = path.join(parent, '.academic-workbench-migrations', path.basename(sourceRoot), `${operationId}.before.zip`);
    const journal = journalPath(sourceRoot);
    try {
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await writeDurable(backupPath, backup, 'wx');
      verifyBackup(new Uint8Array(await fs.readFile(backupPath)));
      await copyTree(sourceRoot, stage);
      for (let version = inspected.schemaVersion; version < targetVersion; version++) {
        for (const file of await migrationFiles(stage)) {
          const relative = path.relative(stage, file).split(path.sep).join('/');
          const source = await fs.readFile(file, 'utf8');
          let value: unknown, body = '';
          const markdown = relative.endsWith('.md');
          if (markdown) {
            const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
            if (!match) throw new Error(`invalid Markdown metadata during migration: ${relative}`);
            try { value = JSON.parse(match[1]); } catch { throw new Error(`invalid Markdown metadata during migration: ${relative}`); }
            body = match[2];
          } else {
            try { value = JSON.parse(source); } catch { throw new Error(`invalid JSON during migration: ${relative}`); }
          }
          const converted = await this.converters[version](value, { filePath: relative, fromVersion: version, toVersion: version + 1 });
          if (converted === undefined) throw new Error(`migration converter returned no value for ${relative}`);
          if (relative === 'workspace.json' && converted && typeof converted === 'object') (converted as Record<string, unknown>).schemaVersion = version + 1;
          await fs.writeFile(file, markdown ? `---\n${JSON.stringify(converted, null, 2)}\n---\n${body}` : JSON.stringify(converted, null, 2) + '\n', { flag: 'w' });
        }
      }
      const sourceWorkspace = JSON.parse(await fs.readFile(path.join(sourceRoot, 'workspace.json'), 'utf8')) as Record<string, unknown>;
      const stagedWorkspace = JSON.parse(await fs.readFile(path.join(stage, 'workspace.json'), 'utf8')) as Record<string, unknown>;
      if (sourceWorkspace.schemaVersion !== inspected.schemaVersion || stagedWorkspace.schemaVersion !== targetVersion) throw new Error('workspace changed during migration');
      const sourceAfter = await this.backup(sourceRoot); verifyBackup(sourceAfter);
      if (!sameBackupFiles(backup, sourceAfter)) throw new Error('workspace changed during migration');
      const displaced = path.join(parent, `.${path.basename(sourceRoot)}.before-${operationId}`);
      const afterFiles = verifyBackup(await this.backup(stage)).manifest.files;
      await writeDurable(journal, JSON.stringify({ root: sourceRoot, operationId, stage, displaced, backupPath, fromVersion: inspected.schemaVersion, toVersion: targetVersion, afterFiles }) + '\n', 'wx');
      await fs.rename(sourceRoot, displaced);
      try { await fs.rename(stage, sourceRoot); } catch (error) { await fs.rename(displaced, sourceRoot); await fs.rm(journal, { force: true }); throw error; }
      try {
        const activatedWorkspace = await this.inspect(sourceRoot);
        if (!activatedWorkspace.supported || activatedWorkspace.schemaVersion !== targetVersion) throw new Error('migrated workspace validation failed');
        const activatedBackup = await this.backup(sourceRoot); verifyBackup(activatedBackup);
      } catch (error) {
        const invalid = path.join(parent, `.${path.basename(sourceRoot)}.invalid-${operationId}`);
        try { await fs.rename(sourceRoot, invalid); await fs.rename(displaced, sourceRoot); await fs.rm(invalid, { recursive: true, force: true }); await fs.rm(journal, { force: true }); } catch (rollbackError) { throw new Error(`migrated workspace validation failed and rollback is incomplete: ${String(error)}; ${String(rollbackError)}`); }
        throw error;
      }
      let cleanupWarning: string | undefined;
      try { await fs.rm(displaced, { recursive: true, force: true }); } catch (error) { cleanupWarning = `migration predecessor cleanup pending: ${String(error)}`; }
      try { await fs.rm(journal, { force: true }); } catch (error) { cleanupWarning = `${cleanupWarning ? `${cleanupWarning}; ` : ''}migration journal cleanup pending: ${String(error)}`; }
      return { schemaVersion: targetVersion, backup, backupPath, ...(cleanupWarning ? { cleanupWarning } : {}) };
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true });
      throw error;
    }
    } finally { await fs.rm(lock, { force: true }); }
  }
}
