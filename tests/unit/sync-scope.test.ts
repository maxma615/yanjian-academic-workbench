import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { selectLocalSyncFiles, validateSnapshot } from '../../src/sync/scope';
import type { SyncSnapshot } from '../../src/sync/contracts';

const id = randomUUID();
const note = (body = '本地正文') => Buffer.from(`---\n${JSON.stringify({ id, type: 'note', schemaVersion: 1, title: '笔记', createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z', revision: 1, paperIds: [] }, null, 2)}\n---\n${body}`);
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));
const snapshot = (files: Record<string, Uint8Array>): SyncSnapshot => ({ files: new Map(Object.entries(files)) });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('M2 synchronization scope', () => {
  it('SY-01 accepts note, log and paper primary files and preserves unknown entity fields', () => {
    const paperId = randomUUID();
    const paper = json({ id: paperId, type: 'paper', schemaVersion: 1, title: '论文', createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z', revision: 1, authors: '', tags: [], readingStatus: 'unread', unknownField: 'keep' });
    const logId = randomUUID();
    const log = Buffer.from(`---\n${JSON.stringify({ id: logId, type: 'log', schemaVersion: 1, title: '日志', date: '2026-09-23', createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z', revision: 1, paperIds: [] })}\n---\n记录`);
    const result = selectLocalSyncFiles(snapshot({ [`notes/${id}.md`]: note(), [`logs/2026/${logId}.md`]: log, [`papers/${paperId}/metadata.json`]: paper, 'tasks/other.json': json({}), 'index/search.sqlite': Buffer.from('db') }));
    expect([...result.files.keys()]).toHaveLength(3);
  });

  it('SY-02 excludes task/event/PDF/backups/state/index and credentials from local upload', () => {
    const files = snapshot({ 'tasks/a.json': json({}), 'events/a.json': json({}), 'papers/x/attachments/a.pdf': Buffer.from('%PDF-1.7'), 'backups/a.zip': Buffer.from('zip'), 'state/local-settings.json': json({}), 'credentials/token': Buffer.from('secret'), 'index/search.sqlite': Buffer.from('sqlite'), [`notes/${id}.md`]: note() });
    expect([...selectLocalSyncFiles(files).files.keys()]).toEqual([`notes/${id}.md`]);
  });

  it('SY-03 accepts only identity-checked tombstones for note/log/paper', () => {
    const value = { schemaVersion: 1, entityType: 'note', entityId: id, originalRelativePath: `notes/${id}.md`, deletedAt: '2026-09-23T00:00:00.000Z', contentHash: 'a'.repeat(64) };
    expect([...validateSnapshot(snapshot({ [`tombstones/note/${id}.json`]: json(value) }), { remote: true }).files]).toHaveLength(1);
  });

  it('SY-04 rejects task/event tombstones and path identity disguises', () => {
    const task = { schemaVersion: 1, entityType: 'task', entityId: id, originalRelativePath: `tasks/${id}.json`, contentHash: 'a'.repeat(64) };
    expect(() => validateSnapshot(snapshot({ [`tombstones/task/${id}.json`]: json(task) }), { remote: true })).toThrow(/同步资料无效/);
    expect(selectLocalSyncFiles(snapshot({ [`tombstones/task/${id}.json`]: json(task) })).files.size).toBe(0);
    const disguised = { ...task, entityType: 'note', originalRelativePath: `notes/${randomUUID()}.md` };
    expect(() => validateSnapshot(snapshot({ [`tombstones/note/${id}.json`]: json(disguised) }), { remote: true })).toThrow(/同步资料无效/);
    const unknown = { ...task, entityType: 'experiment', originalRelativePath: `notes/${id}.md` };
    expect(() => selectLocalSyncFiles(snapshot({ [`tombstones/experiment/${id}.json`]: json(unknown) }))).toThrow(/未知/);
  });

  it('SY-05 validates conflict manifest, source path and content hash', () => {
    const remote = note('远端正文');
    const conflictId = randomUUID();
    const manifest = { schemaVersion: 1, source: 'remote', createdAt: '2026-09-23T00:00:00.000Z', entityType: 'note', entityId: id, originalRelativePath: `notes/${id}.md`, contentHash: hash(remote) };
    expect(validateSnapshot(snapshot({ [`conflicts/${conflictId}/manifest.json`]: json(manifest), [`conflicts/${conflictId}/notes/${id}.md`]: remote }), { remote: true }).files.size).toBe(2);
    expect(() => validateSnapshot(snapshot({ [`conflicts/${conflictId}/manifest.json`]: json(manifest), [`conflicts/${conflictId}/notes/${id}.md`]: Buffer.from('tampered') }), { remote: true })).toThrow(/哈希/);
    expect(() => validateSnapshot(snapshot({ [`conflicts/${conflictId}/manifest.json`]: json(manifest), [`conflicts/${conflictId}/notes/${id}.md`]: json({ type: 'task', id }) }), { remote: true })).toThrow(/身份|前置|哈希/);
    const unknownManifest = { ...manifest, entityType: 'experiment', originalRelativePath: `notes/${id}.md` };
    expect(() => selectLocalSyncFiles(snapshot({ [`conflicts/${conflictId}/manifest.json`]: json(unknownManifest), [`conflicts/${conflictId}/notes/${id}.md`]: note() }))).toThrow(/未知/);
  });

  it('SY-06 rejects unknown remote entries, nested conflict wrapping and malformed JSON', () => {
    expect(() => validateSnapshot(snapshot({ 'README.md': Buffer.from('hello') }), { remote: true })).toThrow(/禁止|未知/);
    const conflictId = randomUUID();
    expect(() => validateSnapshot(snapshot({ [`conflicts/${conflictId}/conflicts/evil/notes/${id}.md`]: note() }), { remote: true })).toThrow(/冲突/);
    expect(() => validateSnapshot(snapshot({ [`notes/${id}.md`]: Buffer.from('{oops') }), { remote: true })).toThrow(/无效|缺少|格式/);
  });

  it('SY-07 rejects invalid primary identity and log year', () => {
    expect(() => validateSnapshot(snapshot({ [`notes/${randomUUID()}.md`]: note() }), { remote: true })).toThrow(/身份/);
    const logId = randomUUID();
    const log = Buffer.from(`---\n${JSON.stringify({ id: logId, type: 'log', schemaVersion: 1, title: '日志', date: '2025-09-23', createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z', revision: 1, paperIds: [] })}\n---\n正文`);
    expect(() => validateSnapshot(snapshot({ [`logs/2026/${logId}.md`]: log }), { remote: true })).toThrow(/年份|身份/);
  });

  it('SY-08 audits a remote tree before any caller can apply it', () => {
    const good = new Map([[`notes/${id}.md`, note()]]);
    good.set('events/hidden.json', json({ id: randomUUID(), type: 'event' }));
    expect(() => validateSnapshot({ files: good }, { remote: true })).toThrow(/禁止/);
  });
});
