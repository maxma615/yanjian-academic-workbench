import { useEffect, useState } from 'react';
import type { SyncView } from '../shared/sync-ui';
import * as api from './api';
export function SyncPanel({ readOnly, onRefresh }: { readOnly: boolean; onRefresh: () => void }) {
  const [view, setView] = useState<SyncView>();
  const [owner, setOwner] = useState(''), [repo, setRepo] = useState(''), [branch, setBranch] = useState('main'), [token, setToken] = useState('');
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  useEffect(() => { void api.syncStatus().then(value => { setView(value); if (value.destination) { setOwner(value.destination.owner); setRepo(value.destination.repo); setBranch(value.destination.branch); } }).catch(error => setError(error.message)); }, []);
  const action = async (work: () => Promise<SyncView>) => { setBusy(true); setError(''); try { setView(await work()); onRefresh(); } catch (error) { setError(error instanceof Error ? error.message : '同步操作失败，本地资料已保留'); } finally { setBusy(false); } };
  return <section className="card settings-card privacy-card"><h2>GitHub 文本同步</h2><p>可选功能。仅同步笔记、研究日志、文献元信息及对应的删除与冲突记录。PDF、待办、日程和账号凭据始终留在本机。</p>
    <p role="status">{view?.message || '正在读取本地同步状态…'}</p>{error && <p role="alert" className="sync-error">{error}</p>}
    {view && !view.available && <p>在桌面应用中连接私人仓库。核心功能在断网时仍可使用。</p>}
    {view?.credentialCleanupPending && <button className="button secondary" disabled={busy || readOnly} onClick={() => void action(api.disconnectSync)}>重试清除凭据</button>}
    {view?.enabled ? <><p>当前仓库：{view.destination?.owner}/{view.destination?.repo} · {view.destination?.branch}</p><div className="backup-actions"><button className="button primary" disabled={busy || readOnly} onClick={() => void action(api.runSync)}>立即同步</button><button className="button secondary" disabled={busy || readOnly} onClick={() => void action(api.disconnectSync)}>断开连接并清除凭据</button></div></> : view?.available && <form className="sync-form" onSubmit={event => { event.preventDefault(); void action(async () => { try { return await api.connectSync({ owner, repo, branch }, token); } finally { setToken(''); } }); }}>
      <label className="field"><span>仓库所有者</span><input required disabled={busy || readOnly} value={owner} onChange={e => setOwner(e.target.value)} autoComplete="off" /></label>
      <label className="field"><span>私人仓库名</span><input required disabled={busy || readOnly} value={repo} onChange={e => setRepo(e.target.value)} autoComplete="off" /></label>
      <label className="field"><span>分支</span><input required disabled={busy || readOnly} value={branch} onChange={e => setBranch(e.target.value)} /></label>
      <label className="field"><span>GitHub 访问令牌</span><input required disabled={busy || readOnly} type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" /></label>
      <p className="full-field">使用专用私人文本仓库及已存在的分支。仓库中如有 README、代码或其他范围外文件，同步会停止，不会自动清理仓库。令牌需要该仓库的 Contents 读写权限，由系统安全存储加密保存。</p>
      <label className="full-field"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> 我确认此私人仓库为同步目的地，并同意上述资料范围</label>
      <button className="button primary" disabled={busy || readOnly || !confirmed}>保存连接设置</button>
    </form>}
    {view?.conflicts.map(conflict => <section className="sync-conflict" key={conflict.id}><h3>冲突：{conflict.path}</h3><p>双方副本已保留。选择后还需点击立即同步。删除与编辑冲突中，保留修改会恢复为新条目。</p><div className="sync-comparison"><details><summary>本地副本</summary><pre>{conflict.localText || '已删除'}</pre></details><details><summary>远端副本</summary><pre>{conflict.remoteText || '已删除'}</pre></details></div><div className="backup-actions"><button className="button secondary" disabled={busy || readOnly} onClick={() => void action(() => api.resolveSync(conflict.id, 'local'))}>采用本地状态</button><button className="button secondary" disabled={busy || readOnly} onClick={() => void action(() => api.resolveSync(conflict.id, 'remote'))}>采用远端状态</button></div><details><summary>编辑合并后的文本</summary><textarea className="markdown-input" rows={10} aria-label={`合并文本 ${conflict.id}`} value={edits[conflict.id] ?? conflict.localText ?? conflict.remoteText ?? ''} onChange={e => setEdits(old => ({ ...old, [conflict.id]: e.target.value }))} /><button className="button secondary" disabled={busy || readOnly} onClick={() => void action(() => api.resolveSync(conflict.id, 'edit', edits[conflict.id] ?? conflict.localText ?? conflict.remoteText ?? ''))}>保存合并结果</button></details></section>)}
  </section>;
}
