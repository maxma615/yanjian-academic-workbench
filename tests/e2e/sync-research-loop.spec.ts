import { test, expect } from '@playwright/test';
import express from 'express';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../../server/app';
import { AppError } from '../../server/fs-safe';
import { serializeEntity } from '../../server/entities';
import type { SyncSnapshot, SyncTransport } from '../../src/sync/contracts';
import { verifyBackup, createBackup } from '../../src/backup/backup-service';

test('optional sync UI preserves a double edit, resolves it, retries offline and disconnects using an isolated simulated repository', async ({ page }) => {
  await fs.mkdir('.test-data', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-data/sync-ui-'));
  let token: string | undefined, sequence = 1, writes = 0, reads = 0, offline = false;
  let remote: SyncSnapshot = { revision: 'r1', files: new Map() };
  const transport: SyncTransport = {
    readSnapshot: async () => { reads++; if (offline) throw new Error('测试模拟断网，本地资料仍可使用'); return { revision: remote.revision, files: new Map(remote.files) }; },
    publish: async (files, expected) => { if (expected !== remote.revision) throw new AppError('revision moved', 409, 'REMOTE_CHANGED'); writes++; remote = { revision: `r${++sequence}`, files: new Map(files) }; return { revision: remote.revision! }; },
  };
  const handle = await createApp(path.join(root, 'workspace'), { controlDirectory: path.join(root, 'control'), sync: { credentials: { getToken: async () => token, setToken: async value => { token = value; }, clear: async () => { token = undefined; } }, transportFactory: () => transport } });
  handle.app.use(express.static(path.resolve('dist')));
  const server = handle.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing fixture port');
  try {
    const note = await handle.getWorkspace().save({ type: 'note', title: '同步研究笔记', body: '最初的结论' });
    const source = `notes/${note.entity.id}.md`;
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('navigation').getByRole('button', { name: '资料与设置' }).click();
    await expect(page.getByText('GitHub 同步未启用，资料保存在本机', { exact: true })).toBeVisible();
    await page.getByLabel('仓库所有者', { exact: true }).fill('fixture'); await page.getByLabel('私人仓库名', { exact: true }).fill('texts');
    await page.getByLabel('GitHub 访问令牌').fill('fixture-secret'); await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '保存连接设置' }).click();
    await expect(page.getByRole('button', { name: '立即同步' })).toBeVisible(); expect(reads).toBe(0);
    await page.getByRole('button', { name: '立即同步' }).click(); await expect(page.getByText('同步完成，本地资料与私人仓库基线已更新', { exact: true })).toBeVisible();
    expect(writes).toBe(1); expect([...remote.files.keys()]).toEqual([source]);
    await handle.getWorkspace().save({ ...note.entity, body: '本地新增观察', expectedRevision: note.entity.revision }, note.entity.id);
    remote.files.set(source, Buffer.from(serializeEntity({ ...note.entity, body: '另一台设备的结论', revision: 2, updatedAt: new Date().toISOString() })));
    remote.revision = `r${++sequence}`;
    await page.getByRole('button', { name: '立即同步' }).click();
    await expect(page.getByRole('heading', { name: `冲突：${source}` })).toBeVisible(); expect(writes).toBe(1);
    await page.getByRole('button', { name: '断开连接并清除凭据' }).click();
    const readsBeforeOfflineResolution = reads;
    await page.getByRole('button', { name: '采用本地状态' }).click();
    await expect(page.getByText('冲突选择已保存到本地，同步保持关闭', { exact: true })).toBeVisible();
    expect(token).toBeUndefined(); expect(reads).toBe(readsBeforeOfflineResolution);
    await expect(page.getByRole('button', { name: '立即同步' })).toHaveCount(0);
    await page.getByLabel('GitHub 访问令牌').fill('fixture-secret');
    await page.getByRole('button', { name: '保存连接设置' }).click();
    await expect(page.getByRole('button', { name: '立即同步' })).toBeVisible();
    await page.getByRole('button', { name: '立即同步' }).click(); await expect(page.getByText('同步完成，本地资料与私人仓库基线已更新', { exact: true })).toBeVisible();
    expect(Buffer.from(remote.files.get(source)!).toString()).toContain('本地新增观察'); expect(writes).toBe(2);
    const backup = verifyBackup(await createBackup(handle.getWorkspace().root));
    expect([...backup.files.values()].some(bytes => Buffer.from(bytes).toString().includes('另一台设备的结论'))).toBe(true);
    expect([...backup.files.keys()].every(name => !name.startsWith('state/'))).toBe(true);
    offline = true; await page.getByRole('button', { name: '立即同步' }).click();
    await expect(page.getByText('测试模拟断网，本地资料仍可使用', { exact: true })).toBeVisible();
    offline = false; await page.getByRole('button', { name: '立即同步' }).click(); await expect(page.getByText('同步完成，本地资料与私人仓库基线已更新', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '断开连接并清除凭据' }).click(); await expect(page.getByRole('button', { name: '保存连接设置' })).toBeVisible();
    expect(token).toBeUndefined(); expect((await handle.getWorkspace().list())[0].body).toBe('本地新增观察');
    await page.screenshot({ path: 'test-results/sync-settings.png', fullPage: true });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); await handle.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
