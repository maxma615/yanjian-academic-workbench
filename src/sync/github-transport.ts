import type { CredentialProvider, SyncBytes, SyncDestination, SyncSnapshot, SyncTransport } from './contracts';
import { AppError } from '../../server/fs-safe';
import { validateSnapshot } from './scope';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type GitTreeEntry = { path: string; mode?: string; type?: string; sha?: string; url?: string };
const MAX_REMOTE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_REMOTE_TOTAL_BYTES = 64 * 1024 * 1024;

export interface GitHubTransportOptions {
  destination: SyncDestination;
  credentials: CredentialProvider;
  fetch?: FetchLike;
  apiBase?: string;
}

/** GitHub's REST Git data API behind the platform-neutral SyncTransport boundary. */
export class GitHubTransport implements SyncTransport {
  readonly destination: SyncDestination;
  private readonly request: FetchLike;
  private readonly apiBase: string;
  constructor(private readonly options: GitHubTransportOptions) {
    this.destination = options.destination;
    if (!/^[A-Za-z0-9_.-]+$/.test(options.destination.owner) || !/^[A-Za-z0-9_.-]+$/.test(options.destination.repo) || !/^[A-Za-z0-9_./-]+$/.test(options.destination.branch) || options.destination.branch.startsWith('/') || options.destination.branch.endsWith('/') || options.destination.branch.includes('..') || options.destination.branch.includes('//') || options.destination.branch.includes('@{')) throw new AppError('GitHub 私人仓库目标无效');
    this.request = options.fetch ?? fetch;
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  }
  private path(suffix: string) { return `${this.apiBase}/repos/${encodeURIComponent(this.destination.owner)}/${encodeURIComponent(this.destination.repo)}${suffix}`; }
  private async token() {
    const token = await this.options.credentials.getToken();
    if (!token) throw new AppError('GitHub 凭据未连接', 401, 'SYNC_CREDENTIAL_MISSING');
    return token;
  }
  private async api(url: string, init?: RequestInit, options: { refUpdate?: boolean } = {}): Promise<any> {
    const token = await this.token();
    let response: Response;
    try {
      response = await this.request(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000), headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(init?.headers ?? {}) } });
    } catch {
      throw new AppError('GitHub 网络请求超时或暂时不可用，请稍后重试；本地资料已保留', 503, 'SYNC_RETRYABLE');
    }
    if (!response.ok) {
      // Do not echo response bodies: a misconfigured proxy could reflect an
      // Authorization header or other credential material.
      const error = new AppError(`GitHub 请求失败（${response.status}）`, response.status, response.status === 409 || (options.refUpdate && response.status === 422) ? 'REMOTE_CHANGED' : 'SYNC_REMOTE_ERROR');
      throw error;
    }
    if (response.status === 204) return undefined;
    try { return await response.json(); } catch { throw new AppError('GitHub 返回了无法读取的响应，请稍后重试', 502, 'SYNC_RETRYABLE'); }
  }
  private async verifyPrivate() {
    const repo = await this.api(this.path(''));
    if (repo.private !== true) throw new AppError('同步目标必须是私人仓库，已拒绝公开仓库', 403, 'SYNC_REPOSITORY_NOT_PRIVATE');
    return repo;
  }
  private async readTreeAtCommit(commitSha: string): Promise<{ commit: any; files: Map<string, SyncBytes> }> {
    const commit = await this.api(this.path(`/git/commits/${encodeURIComponent(commitSha)}`));
    const tree = await this.api(this.path(`/git/trees/${encodeURIComponent(commit.tree?.sha)}?recursive=1`));
    if (tree.truncated) throw new AppError('GitHub 资料树过大，已拒绝不完整快照', 413, 'SYNC_REMOTE_ERROR');
    const files = new Map<string, SyncBytes>();
    let total = 0;
    for (const entry of (tree.tree ?? []) as GitTreeEntry[]) {
      if (typeof entry.path !== 'string' || !entry.path) throw new AppError('GitHub 资料树含无效路径', 502, 'SYNC_REMOTE_ERROR');
      if (entry.type === 'tree') continue;
      if (entry.type !== 'blob' || !entry.sha || !['100644', '100755'].includes(entry.mode ?? '')) throw new AppError(`GitHub 资料树含不支持的文件类型：${entry.path}`, 400, 'SYNC_SCOPE_INVALID');
      if (files.has(entry.path)) throw new AppError(`GitHub 资料树含重复路径：${entry.path}`, 400, 'SYNC_SCOPE_INVALID');
      const blob = await this.api(this.path(`/git/blobs/${entry.sha}`));
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new AppError(`GitHub 文件内容无法读取：${entry.path}`, 502, 'SYNC_REMOTE_ERROR');
      const bytes = new Uint8Array(Buffer.from(blob.content.replace(/\s/g, ''), 'base64'));
      if (bytes.length > MAX_REMOTE_FILE_BYTES || (total += bytes.length) > MAX_REMOTE_TOTAL_BYTES) throw new AppError('GitHub 资料树超过同步大小限制', 413, 'SYNC_SCOPE_INVALID');
      files.set(entry.path, bytes);
    }
    return { commit, files };
  }
  async readSnapshot(): Promise<SyncSnapshot> {
    const repo = await this.verifyPrivate();
    const ref = await this.api(this.path(`/git/ref/heads/${encodeURIComponent(this.destination.branch)}`));
    const commitSha = ref.object?.sha;
    if (typeof commitSha !== 'string') throw new AppError('GitHub 分支修订标识无效', 502, 'SYNC_REMOTE_ERROR');
    const { files } = await this.readTreeAtCommit(commitSha);
    void repo;
    return { revision: commitSha, files };
  }
  async publish(files: Map<string, SyncBytes>, expectedRevision?: string): Promise<{ revision: string }> {
    await this.verifyPrivate();
    if (!expectedRevision) throw new AppError('发布同步资料缺少远端修订条件', 409, 'REMOTE_CHANGED');
    // Read the commit/tree associated with the expected commit. Updating the ref
    // uses force:false, so a concurrent remote commit cannot be overwritten.
    const { commit, files: remoteFiles } = await this.readTreeAtCommit(expectedRevision);
    // A standalone publish must audit the full tree before constructing a
    // deletion tree; otherwise a README or an unrelated file could be deleted
    // simply because it was absent from the sync view.
    const auditedRemote = validateSnapshot({ revision: expectedRevision, files: remoteFiles }, { remote: true });
    const auditedFiles = validateSnapshot({ files }, { remote: false }).files;
    const current = new Set<string>(auditedRemote.files.keys());
    const treeEntries: Array<Record<string, string | null>> = [];
    for (const path of current) if (!auditedFiles.has(path)) treeEntries.push({ path, mode: '100644', type: 'blob', sha: null });
    for (const [path, bytes] of [...auditedFiles].sort(([a], [b]) => a.localeCompare(b))) {
      const blob = await this.api(this.path('/git/blobs'), { method: 'POST', body: JSON.stringify({ content: Buffer.from(bytes).toString('base64'), encoding: 'base64' }), headers: { 'Content-Type': 'application/json' } });
      treeEntries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const tree = await this.api(this.path('/git/trees'), { method: 'POST', body: JSON.stringify({ base_tree: commit.tree.sha, tree: treeEntries }), headers: { 'Content-Type': 'application/json' } });
    const newCommit = await this.api(this.path('/git/commits'), { method: 'POST', body: JSON.stringify({ message: '同步学术工作台文本资料', tree: tree.sha, parents: [expectedRevision] }), headers: { 'Content-Type': 'application/json' } });
    await this.api(this.path(`/git/refs/heads/${encodeURIComponent(this.destination.branch)}`), { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }), headers: { 'Content-Type': 'application/json' } }, { refUpdate: true });
    return { revision: newCommit.sha };
  }
}
