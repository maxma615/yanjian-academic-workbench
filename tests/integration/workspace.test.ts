import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../../server/workspace';
import { atomicWrite, hash } from '../../server/fs-safe';

const roots: string[] = [], opened: Workspace[] = [];
async function fixture() {
  await fs.mkdir('.test-data', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-data/workspace-')); roots.push(root);
  const ws = await Workspace.open(root); opened.push(ws); return ws;
}
afterEach(async () => { for (const ws of opened.splice(0)) await ws.close(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('authoritative research workspace', () => {
  it('persists readable markdown, paper links and same-day logs across restart', async () => {
    const ws = await fixture();
    const paper = (await ws.save({ type: 'paper', title: '中文文献', authors: '研究者' })).entity;
    const note = (await ws.save({ type: 'note', title: '阅读笔记', body: '消融实验记录', paperIds: [paper.id], customMetadata: 'keep' })).entity;
    const log1 = (await ws.save({ type: 'log', title: '实验过程', date: '2026-09-23', body: '结果' })).entity;
    const log2 = (await ws.save({ type: 'log', title: '下一步', date: '2026-09-23' })).entity;
    expect(log1.id).not.toBe(log2.id);
    expect(await fs.readFile(path.join(ws.root, `notes/${note.id}.md`), 'utf8')).toContain('消融实验记录');
    const root = ws.root; await ws.close();
    const again = await Workspace.open(root); opened.push(again);
    expect((await again.list()).find(x => x.id === note.id)).toMatchObject({ body: '消融实验记录', paperIds: [paper.id], customMetadata: 'keep' });
    expect((await again.search('消融实验')).map(x => x.id)).toContain(note.id);
  });

  it('rejects stale edits and makes a second writer read-only', async () => {
    const ws = await fixture(); const entity = (await ws.save({ type: 'task', title: '实验' })).entity;
    const other = await Workspace.open(ws.root); opened.push(other);
    expect(other.readOnly).toBe(true);
    await expect(other.save({ type: 'task', title: '不应写入' })).rejects.toThrow(/只读/);
    await ws.save({ ...entity, title: '已更新', expectedRevision: entity.revision }, entity.id);
    await expect(ws.save({ ...entity, title: '旧版本', expectedRevision: entity.revision }, entity.id)).rejects.toThrow(/修改/);
    expect((await ws.list()).find(x => x.id === entity.id)?.title).toBe('已更新');
  });

  it('stops writes after the writer lock is compromised', async () => {
    const ws = await fixture();
    await fs.rm(path.join(ws.root, 'state/writer.lock'), { recursive: true, force: true });
    await new Promise(resolve => setTimeout(resolve, 3_500));
    await expect(ws.save({ type: 'task', title: '锁失效后不得写入' })).rejects.toMatchObject({ code: 'LOCK_COMPROMISED' });
  });

  it('does not let an old instance commit after a replacement writer acquires the lock', async () => {
    const ws = await fixture();
    const entity = (await ws.save({ type: 'task', title: '基线' })).entity;
    let entered!: () => void;
    let release!: () => void;
    const beforeCommit = new Promise<void>(resolve => { entered = resolve; });
    const continueCommit = new Promise<void>(resolve => { release = resolve; });
    const oldWrite = atomicWrite(ws.root, `tasks/${entity.id}.json`, 'stale old writer', async () => { entered(); await continueCommit; await (ws as unknown as { assertWriterLock: () => Promise<void> }).assertWriterLock(); });
    await beforeCommit;
    await fs.rm(path.join(ws.root, 'state/writer.lock'), { recursive: true, force: true });
    const replacement = await Workspace.open(ws.root); opened.push(replacement);
    await replacement.save({ ...entity, title: '新实例版本', expectedRevision: entity.revision }, entity.id);
    release();
    await expect(oldWrite).rejects.toMatchObject({ code: 'LOCK_COMPROMISED' });
    expect((await replacement.get(entity.id)).title).toBe('新实例版本');
  });

  it('does not open while the sibling migration lock is present', async () => {
    const ws = await fixture();
    const root = ws.root;
    await ws.close(); opened.splice(opened.indexOf(ws), 1);
    const marker = path.join(path.dirname(root), `.${path.basename(root)}.migration-lock`);
    await fs.writeFile(marker, 'migration in progress');
    await expect(Workspace.open(root)).rejects.toMatchObject({ code: 'MIGRATION_IN_PROGRESS' });
    await fs.rm(marker, { force: true });
  });

  it('allows editing a note after its paper is deleted but rejects newly added missing references', async () => {
    const ws = await fixture();
    const paper = (await ws.save({ type: 'paper', title: '已删除文献' })).entity;
    const note = (await ws.save({ type: 'note', title: '关联笔记', body: '原文', paperIds: [paper.id] })).entity;
    await ws.remove(paper.id, paper.revision);

    const edited = await ws.save({ ...note, title: '继续编辑', body: '保留历史关联', expectedRevision: note.revision }, note.id);
    expect(edited.entity.body).toBe('保留历史关联');
    await expect(ws.save({ ...edited.entity, paperIds: [...(edited.entity.paperIds ?? []), '123e4567-e89b-12d3-a456-426614174000'], expectedRevision: edited.entity.revision }, note.id)).rejects.toThrow(/关联文献不存在/);
  });

  it('validates dates, invalid associations and imports PDF before linking it', async () => {
    const ws = await fixture();
    await expect(ws.save({ type: 'task', title: '  ' })).rejects.toThrow();
    await expect(ws.save({ type: 'log', title: '日志', date: '2026-02-30' })).rejects.toThrow();
    await expect(ws.save({ type: 'event', title: '会议', start: '2026-09-24T10:00:00+08:00', end: '2026-09-24T09:00:00+08:00' })).rejects.toThrow();
    await expect(ws.save({ type: 'note', title: '笔记', paperIds: ['../secret'] })).rejects.toThrow();
    const paper = (await ws.save({ type: 'paper', title: 'PDF文献' })).entity;
    await expect(ws.importPdf(paper.id, 'bad.pdf', Buffer.from('not PDF'), paper.revision)).rejects.toThrow(/PDF/);
    expect((await ws.list()).find(x => x.id === paper.id)?.attachments).toEqual([]);
    const bytes = Buffer.from('%PDF-1.4\nresearch\n%%EOF');
    const result = await ws.importPdf(paper.id, '研究.pdf', bytes, paper.revision);
    const pdf = await ws.readAttachment(paper.id, result.entity.attachments![0].id);
    expect(pdf.bytes).toEqual(bytes);
  });

  it('rebuilds a missing or corrupt SQLite index from the authoritative files', async () => {
    const ws = await fixture(); const note = (await ws.save({ type: 'note', title: '索引测试', body: '中文全文检索' })).entity;
    const root = ws.root; await ws.close();
    await fs.writeFile(path.join(root, 'index/search.sqlite'), 'corrupt');
    const again = await Workspace.open(root); opened.push(again);
    expect((await again.search('中文全文')).map(x => x.id)).toContain(note.id);
    expect(await fs.readFile(path.join(root, `notes/${note.id}.md`), 'utf8')).toContain('中文全文检索');
  });

  it('reports malformed primary fields with the source file path', async () => {
    const ws = await fixture();
    const task = (await ws.save({ type: 'task', title: '损坏字段' })).entity;
    const file = path.join(ws.root, `tasks/${task.id}.json`);
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    delete value.updatedAt;
    await fs.writeFile(file, JSON.stringify(value));
    await expect(ws.list()).rejects.toThrow(new RegExp(`tasks/${task.id}\\.json`));
  });

  it('moves logs across years and rejects a changed source during replay', async () => {
    const ws = await fixture();
    const log = (await ws.save({ type: 'log', title: '跨年日志', date: '2026-12-31', body: '原始内容' })).entity;
    const source = await fs.readFile(path.join(ws.root, `logs/2026/${log.id}.md`), 'utf8');
    const moved = (await ws.save({ ...log, date: '2027-01-01', expectedRevision: log.revision }, log.id)).entity;
    expect(await fs.readFile(path.join(ws.root, `logs/2027/${log.id}.md`), 'utf8')).toContain('2027-01-01');
    await ws.close(); opened.splice(opened.indexOf(ws), 1);

    const root = ws.root;
    await fs.rm(path.join(root, `logs/2027/${log.id}.md`));
    await fs.mkdir(path.join(root, 'logs/2026'), { recursive: true });
    await fs.writeFile(path.join(root, `logs/2026/${log.id}.md`), source);
    const content = source.replace('2026-12-31', '2027-01-01');
    await fs.mkdir(path.join(root, 'state/moves'), { recursive: true });
    await fs.writeFile(path.join(root, 'state/moves/replay.json'), JSON.stringify({ from: `logs/2026/${log.id}.md`, to: `logs/2027/${log.id}.md`, content, sourceHash: '0'.repeat(64), completed: false }));
    await expect(Workspace.open(root)).rejects.toThrow(/日志移动源资料已变化/);
  });

  it.skipIf(process.platform === 'win32')('opens read-only with a recovery warning when an otherwise valid move cannot remove the old log', async () => {
    const ws = await fixture();
    const log = (await ws.save({ type: 'log', title: '待恢复日志', date: '2026-12-31', body: '旧正文' })).entity;
    const sourcePath = path.join(ws.root, `logs/2026/${log.id}.md`);
    const source = await fs.readFile(sourcePath);
    const moved = (await ws.save({ ...log, date: '2027-01-01', body: '新正文', expectedRevision: log.revision }, log.id)).entity;
    const destinationPath = path.join(ws.root, `logs/2027/${log.id}.md`);
    const destination = await fs.readFile(destinationPath);
    const root = ws.root;
    await ws.close(); opened.splice(opened.indexOf(ws), 1);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, source);
    await fs.writeFile(path.join(root, 'state/moves/recovery-warning.json'), JSON.stringify({ from: `logs/2026/${log.id}.md`, to: `logs/2027/${log.id}.md`, content: destination.toString('utf8'), sourceHash: hash(source), completed: false }));
    await fs.chmod(path.dirname(sourcePath), 0o500);
    let recovered: Workspace;
    try { recovered = await Workspace.open(root); } finally { await fs.chmod(path.dirname(sourcePath), 0o700); }
    opened.push(recovered);
    expect(recovered.readOnly).toBe(true);
    expect(recovered.recoveryWarning).toMatch(/旧日志/);
    expect((await recovered.list()).find(item => item.id === moved.id)?.body).toBe('新正文');
    expect(await fs.readFile(sourcePath)).toEqual(source);
    expect(await fs.readFile(destinationPath)).toEqual(destination);
    await expect(recovered.save({ type: 'task', title: '恢复期间不得写入' })).rejects.toMatchObject({ code: 'RECOVERY_WARNING' });
    await recovered.close(); opened.splice(opened.indexOf(recovered), 1);
    const stillReadOnly = await Workspace.open(root); opened.push(stillReadOnly);
    expect(stillReadOnly.readOnly).toBe(true);
    expect((await stillReadOnly.list()).filter(item => item.id === moved.id)).toHaveLength(1);
    await stillReadOnly.close(); opened.splice(opened.indexOf(stillReadOnly), 1);
    await fs.rm(sourcePath);
    const repaired = await Workspace.open(root); opened.push(repaired);
    expect(repaired.readOnly).toBe(false);
    expect((await repaired.list()).find(item => item.id === moved.id)?.body).toBe('新正文');
  });

  it('keeps the workspace open with a stale search index when index initialization fails', async () => {
    const ws = await fixture();
    const note = (await ws.save({ type: 'note', title: '索引故障', body: '主文件仍可读' })).entity;
    const root = ws.root;
    await ws.close(); opened.splice(opened.indexOf(ws), 1);
    await fs.rm(path.join(root, 'index/search.sqlite'), { force: true });
    await fs.mkdir(path.join(root, 'index/search.sqlite'), { recursive: true });
    const again = await Workspace.open(root); opened.push(again);
    expect(again.indexStatus).toBe('stale');
    expect((await again.search('主文件')).map(x => x.id)).toContain(note.id);
  });

  it('rebuilds search results after an external markdown edit', async () => {
    const ws = await fixture();
    const note = (await ws.save({ type: 'note', title: '外部编辑', body: '旧内容' })).entity;
    const file = path.join(ws.root, `notes/${note.id}.md`);
    const text = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, text.replace('旧内容', '外部新增内容'));
    expect((await ws.search('外部新增')).map(x => x.id)).toContain(note.id);
  });

  it('keeps deletion snapshots and tombstones and serializes a stable backup snapshot', async () => {
    const ws = await fixture(); const paper = (await ws.save({ type: 'paper', title: '待删除' })).entity;
    const withPdf = (await ws.importPdf(paper.id, 'a.pdf', Buffer.from('%PDF-1.4\n%%EOF'), paper.revision)).entity;
    await ws.remove(withPdf.id, withPdf.revision);
    expect(await ws.list()).toHaveLength(0);
    expect(JSON.parse(await fs.readFile(path.join(ws.root, `tombstones/paper/${paper.id}.json`), 'utf8'))).toMatchObject({ entityId: paper.id, entityType: 'paper' });
    expect((await fs.readdir(path.join(ws.root, 'deletion-snapshots'))).length).toBe(1);
    const first = ws.exclusive(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return (await ws.list()).length; });
    const save = ws.save({ type: 'task', title: '快照之后' });
    expect(await first).toBe(0); await save;
    expect(await ws.list()).toHaveLength(1);
  });
});
