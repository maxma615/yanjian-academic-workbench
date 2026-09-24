import { AppError, exists, readSafe, safePath } from './fs-safe';
import type { Workspace } from './workspace';
import { WorkspaceSyncAdapter } from './sync-workspace';
import { SyncEngine } from '../src/sync/sync-engine';
import { GitHubTransport } from '../src/sync/github-transport';
import type { CredentialProvider, SyncDestination, SyncTransport } from '../src/sync/contracts';
import type { SyncView } from '../src/shared/sync-ui';

export interface SyncRuntimeOptions {
  credentials?: CredentialProvider;
  credentialsAvailable?: () => boolean;
  transportFactory?: (destination: SyncDestination, credentials: CredentialProvider) => SyncTransport;
}
type Config = { schemaVersion: 1; enabled: boolean; credentialCleanupPending?: boolean; destination?: SyncDestination };
const configFile = 'state/sync-config.json';
function destinationOf(value: any): SyncDestination {
  if (!value || !['owner', 'repo'].every(key => typeof value[key] === 'string' && /^[A-Za-z0-9_.-]+$/.test(value[key]) && value[key].length <= 100) || typeof value.branch !== 'string' || value.branch.length > 200 || !/^[A-Za-z0-9_./-]+$/.test(value.branch) || value.branch.startsWith('/') || value.branch.endsWith('/') || value.branch.includes('..') || value.branch.includes('//') || value.branch.endsWith('.lock')) throw new AppError('请填写有效的仓库所有者、仓库名和分支');
  return { owner: value.owner, repo: value.repo, branch: value.branch };
}

/** Invoked inside the application's serial queue; configuration contains no secrets. */
export class SyncRuntime {
  private results = new Map<string, { status: string; message: string }>();
  constructor(private readonly options: SyncRuntimeOptions = {}) {}
  private async config(workspace: Workspace): Promise<Config> {
    if (!await exists(await safePath(workspace.root, configFile))) return { schemaVersion: 1, enabled: false };
    const value = JSON.parse((await readSafe(workspace.root, configFile)).toString());
    if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') throw new AppError('同步设置损坏，请检查本地资料');
    return { schemaVersion: 1, enabled: value.enabled, credentialCleanupPending: value.credentialCleanupPending === true, destination: value.destination ? destinationOf(value.destination) : undefined };
  }
  private available() { return Boolean(this.options.credentials?.setToken) && (this.options.credentialsAvailable?.() ?? true); }
  private writeConfig(workspace: Workspace, config: Config) { return workspace.exclusive(() => workspace.syncWriteAtomically(configFile, JSON.stringify(config))); }
  private engine(workspace: Workspace, config: Config) {
    const credentials = this.options.credentials;
    const transport = config.destination && credentials
      ? (this.options.transportFactory?.(config.destination, credentials) ?? new GitHubTransport({ destination: config.destination, credentials })) : undefined;
    return new SyncEngine({ enabled: config.enabled, workspace: new WorkspaceSyncAdapter(workspace), transport, credentials });
  }
  async status(workspace: Workspace): Promise<SyncView> {
    const config = await this.config(workspace);
    const snapshot = await new WorkspaceSyncAdapter(workspace).readSyncSnapshot();
    const conflicts = [...snapshot.files].filter(([name]) => /^conflicts\/[^/]+\/manifest\.json$/.test(name)).map(([name, bytes]) => {
      const manifest = JSON.parse(Buffer.from(bytes).toString());
      const id = name.split('/')[1], original = manifest.originalRelativePath;
      const text = (bytes?: Uint8Array) => bytes ? Buffer.from(bytes).toString('utf8') : undefined;
      return { id, path: original, localText: text(snapshot.files.get(original)), remoteText: text(snapshot.files.get(`conflicts/${id}/${original}`)) };
    });
    const last = this.results.get(workspace.root);
    return { available: this.available(), enabled: config.enabled, credentialCleanupPending: config.credentialCleanupPending, destination: config.destination,
      status: conflicts.length ? 'conflict' : !config.enabled ? 'disabled' : last?.status ?? 'connected',
      message: config.credentialCleanupPending ? '同步已停用，但凭据尚待清除。请重试清除凭据' : conflicts.length ? `有 ${conflicts.length} 项冲突等待处理` : last?.message ?? (config.enabled ? '已配置私人仓库，点击立即同步开始' : 'GitHub 同步未启用，资料保存在本机'), conflicts };
  }
  async connect(workspace: Workspace, body: any): Promise<SyncView> {
    workspace.assertWritable();
    if (!this.options.credentials?.setToken || !this.available()) throw new AppError('需要桌面应用及可用的系统安全存储才能连接仓库', 403);
    if (body?.authorized !== true) throw new AppError('需要明确确认私人仓库目标与同步范围');
    const destination = destinationOf(body?.destination);
    if (typeof body?.token !== 'string' || !body.token.trim() || body.token.length > 8192 || /[\r\n]/.test(body.token)) throw new AppError('请填写有效的 GitHub 访问令牌');
    const existing = await this.config(workspace);
    if (existing.destination && JSON.stringify(existing.destination) !== JSON.stringify(destination)) throw new AppError('此资料目录已绑定其他仓库。请使用独立资料目录连接新仓库，以免混用同步基线', 409);
    // Disable durably before touching credentials, including when replacing an existing token.
    const pending: Config = { schemaVersion: 1, enabled: false, destination, credentialCleanupPending: true };
    await this.writeConfig(workspace, pending);
    try {
      await this.options.credentials.setToken(body.token);
      await this.writeConfig(workspace, { ...pending, enabled: true, credentialCleanupPending: false });
    } catch {
      try { await this.options.credentials.clear?.(); await this.writeConfig(workspace, { ...pending, credentialCleanupPending: false }); }
      catch { throw new AppError('连接未启用；凭据尚待清除，请重试清除凭据'); }
      throw new AppError('连接设置未完成，已停用同步并清除凭据，请重试');
    }
    this.results.delete(workspace.root);
    return this.status(workspace);
  }
  async disconnect(workspace: Workspace): Promise<SyncView> {
    workspace.assertWritable();
    const config = await this.config(workspace);
    // Persist disabled first so a credential cleanup failure cannot resume remote operations.
    await this.writeConfig(workspace, { ...config, enabled: false, credentialCleanupPending: true });
    this.results.delete(workspace.root);
    try {
      await this.options.credentials?.clear?.();
      await this.writeConfig(workspace, { ...config, enabled: false, credentialCleanupPending: false });
    } catch { /* The persisted pending flag keeps cleanup visible and retryable. */ }
    return this.status(workspace);
  }
  async sync(workspace: Workspace): Promise<SyncView> {
    workspace.assertWritable();
    const config = await this.config(workspace);
    try {
      const result = await this.engine(workspace, config).syncNow();
      this.results.set(workspace.root, { status: result.status, message: result.message });
    } catch (error) {
      this.results.set(workspace.root, { status: 'failed', message: error instanceof Error ? error.message : '同步失败，本地资料已保留' });
    }
    return this.status(workspace);
  }
  async resolve(workspace: Workspace, body: any): Promise<SyncView> {
    workspace.assertWritable();
    if (typeof body?.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.id) || !['local', 'remote', 'edit'].includes(body.choice)) throw new AppError('冲突处理选项无效');
    if (body.choice === 'edit' && (typeof body.editedText !== 'string' || Buffer.byteLength(body.editedText) > 4 * 1024 * 1024)) throw new AppError('编辑内容无效或过大');
    const config = await this.config(workspace);
    await this.engine(workspace, config).resolveConflict(body.id, body.choice, body.choice === 'edit' ? Buffer.from(body.editedText) : undefined);
    this.results.set(workspace.root, { status: config.enabled ? 'connected' : 'disabled', message: config.enabled ? '冲突选择已保存到本地，请再次同步以发布' : '冲突选择已保存到本地，同步保持关闭' });
    return this.status(workspace);
  }
}
