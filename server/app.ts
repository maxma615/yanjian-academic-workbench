import express, { type Request, type Response, type NextFunction } from 'express';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Workspace } from './workspace';
import { SyncRuntime, type SyncRuntimeOptions } from './sync-runtime';
import { AppError, atomicWrite, exists, readSafe } from './fs-safe';
import { createBackup, verifyBackup, RestoreManager } from '../src/backup/backup-service';

function equal(a: unknown, b: string) { return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function bytesFromBody(body: any) {
  if (typeof body?.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) throw new AppError('文件内容格式无效');
  return Buffer.from(body.base64, 'base64');
}
function attachment(res: Response, bytes: Uint8Array, name: string, contentType: string) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(Buffer.from(bytes));
}
export async function createApp(directory: string, options: { controlDirectory?: string; nativeDialogs?: boolean; sync?: SyncRuntimeOptions } = {}) {
  const controlDirectory = path.resolve(options.controlDirectory ?? path.join(path.dirname(directory), 'control'));
  await fs.mkdir(controlDirectory, { recursive: true });
  if ((await fs.lstat(controlDirectory)).isSymbolicLink()) throw new AppError('应用状态目录不能为链接');
  const pointerPath = path.join(controlDirectory, 'active-workspace.json');
  let activeDirectory = directory;
  if (await exists(pointerPath)) {
    const pointer = JSON.parse((await readSafe(controlDirectory, 'active-workspace.json')).toString());
    if (typeof pointer.path !== 'string' || !path.isAbsolute(pointer.path) || !await exists(pointer.path)) throw new AppError('上次使用的资料目录不可用，请检查目录位置');
    activeDirectory = pointer.path;
  }
  let workspace = await Workspace.open(activeDirectory);
  const sync = new SyncRuntime(options.sync);
  const retiredWorkspaces = new Set<Workspace>();
  let serial: Promise<unknown> = Promise.resolve();
  function run<T>(work: () => Promise<T>): Promise<T> { const result = serial.then(work); serial = result.catch(() => undefined); return result; }
  const restoreManager = new RestoreManager({
    getActiveRoot: () => workspace.root,
    validateStaged: async root => {
      const candidate = await Workspace.open(root);
      try {
        const entities = await candidate.list(), paperIds = new Set(entities.filter(e => e.type === 'paper').map(e => e.id));
        for (const entity of entities) {
          // References to deleted papers are retained as history; unknown IDs are invalid backups.
          for (const id of entity.paperIds ?? []) if (!paperIds.has(id)) {
            let tombstone: any;
            try { tombstone = JSON.parse((await readSafe(root, `tombstones/paper/${id}.json`)).toString()); }
            catch { throw new AppError('备份包含无法解释的文献关联'); }
            if (tombstone.entityType !== 'paper' || tombstone.entityId !== id || tombstone.originalRelativePath !== `papers/${id}/metadata.json`) throw new AppError('备份包含无法解释的文献关联');
          }
          for (const pdf of entity.attachments ?? []) if (pdf.available) await candidate.readAttachment(entity.id, pdf.id);
        }
        await candidate.rebuildIndex();
      } finally { await candidate.close(); }
    },
    activate: async root => {
      const candidate = await Workspace.open(root);
      if (candidate.readOnly) { await candidate.close(); throw new AppError('恢复目标已被其他实例占用'); }
      try { await candidate.rebuildIndex(); await atomicWrite(controlDirectory, 'active-workspace.json', JSON.stringify({ path: root })); }
      catch (e) { await candidate.close(); throw e; }
      // Publishing the durable pointer is the activation commit. A later lock-release
      // failure must never make RestoreManager roll back the now-active directory.
      const previous = workspace; workspace = candidate;
      try { await previous.close(); }
      catch { retiredWorkspaces.add(previous); console.warn('恢复已完成；旧资料目录的写锁将在应用退出时再次释放。'); }
    },
  });
  const app = express(); app.disable('x-powered-by');
  const token = randomBytes(32).toString('hex'), cookie = randomBytes(32).toString('hex');
  // Cookies are shared across ports. Separate names prevent a second local
  // instance from invalidating the first instance's authenticated browser tabs.
  const cookieName = `awb_session_${token.slice(0, 16)}`;
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (!host || !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)) return res.status(403).json({ error: '仅允许本机访问' });
    if (req.headers.origin && req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '请求来源不受信任' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.get('/api/session', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.cookie(cookieName, cookie, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.json({ token });
  });
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map(part => part.trim().split('=')));
    if (!equal(req.headers['x-workbench-token'], token) || !equal(cookies[cookieName], cookie)) return res.status(401).json({ error: '本机连接已过期，请重新连接后重试', code: 'SESSION_EXPIRED' });
    next();
  });
  app.use('/api', express.json({ limit: '160mb' }));
  const route = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { run(() => handler(req, res)).catch(next); };
  app.get('/api/sync', route(async (_req, res) => { res.json(await sync.status(workspace)); }));
  app.post('/api/sync/connect', route(async (req, res) => { res.json(await sync.connect(workspace, req.body)); }));
  app.post('/api/sync/disconnect', route(async (_req, res) => { res.json(await sync.disconnect(workspace)); }));
  app.post('/api/sync/run', route(async (_req, res) => { res.json(await sync.sync(workspace)); }));
  app.post('/api/sync/resolve', route(async (req, res) => { res.json(await sync.resolve(workspace, req.body)); }));
  app.get('/api/state', route(async (_req, res) => { res.json(await workspace.state()); }));
  app.get('/api/search', route(async (req, res) => { res.json({ results: await workspace.search(typeof req.query.q === 'string' ? req.query.q : '') }); }));
  app.post('/api/entities', route(async (req, res) => { res.status(201).json(await workspace.save(req.body)); }));
  app.put('/api/entities/:id', route(async (req, res) => { res.json(await workspace.save(req.body, String(req.params.id))); }));
  app.delete('/api/entities/:id', route(async (req, res) => { await workspace.remove(String(req.params.id), req.body?.expectedRevision); res.json({ ok: true }); }));
  app.post('/api/papers/:id/pdf', route(async (req, res) => { res.json(await workspace.importPdf(String(req.params.id), req.body?.name, bytesFromBody(req.body), req.body?.expectedRevision)); }));
  app.get('/api/papers/:id/pdf/:attachmentId', route(async (req, res) => { const file = await workspace.readAttachment(String(req.params.id), String(req.params.attachmentId)); attachment(res, file.bytes, file.name, 'application/pdf'); }));
  app.get('/api/entities/:id/export', route(async (req, res) => { const file = await workspace.exportEntity(String(req.params.id)); attachment(res, file.bytes, file.name, 'application/octet-stream'); }));
  app.post('/api/index/rebuild', route(async (_req, res) => { await workspace.rebuildIndex(); res.json({ ok: true }); }));
  app.post('/api/backup', route(async (_req, res) => {
    const bytes = await workspace.exclusive(() => createBackup(workspace.root));
    verifyBackup(bytes); attachment(res, bytes, `研笺-完整备份-${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip');
  }));
  app.post('/api/restore/inspect', route(async (req, res) => { res.json({ manifest: verifyBackup(bytesFromBody(req.body)).manifest }); }));
  app.post('/api/restore/target', route(async (req, res) => { if (options.nativeDialogs) throw new AppError('请通过系统对话框选择恢复目录', 403); workspace.assertWritable(); if (typeof req.body?.path !== 'string') throw new AppError('请选择恢复空目录'); res.json(await restoreManager.selectTarget(req.body.path)); }));
  app.post('/api/restore', route(async (req, res) => { if (options.nativeDialogs) throw new AppError('请通过桌面恢复入口操作', 403); workspace.assertWritable(); res.json(await restoreManager.restore(bytesFromBody(req.body), req.body?.targetToken)); }));
  app.use('/api', (_req, res) => { res.status(404).json({ error: '请求不存在' }); });
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof AppError ? error.status : error.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({ error: error.type === 'entity.too.large' ? '导入文件过大，请减少单次导入大小' : error instanceof Error ? error.message : '操作失败，已保留原资料', code: error.code });
  });
  return {
    app, getWorkspace: () => workspace,
    runWithWorkspace: <T>(work: (active: Workspace) => Promise<T>): Promise<T> => run(() => work(workspace)),
    selectRestoreTarget: (selectedPath: string) => run(async () => { workspace.assertWritable(); return restoreManager.selectTarget(selectedPath); }),
    restoreBackup: (bytes: Uint8Array, token: string) => run(async () => { workspace.assertWritable(); return restoreManager.restore(bytes, token); }),
    close: async () => { await serial; await workspace.close(); await Promise.allSettled([...retiredWorkspaces].map(previous => previous.close())); },
  };
}
