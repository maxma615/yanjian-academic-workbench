import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reconcile } from '../../src/sync/reconcile';

const path = `notes/${randomUUID()}.md`;
const snap = (value?: string) => ({ files: value === undefined ? new Map() : new Map([[path, Buffer.from(value)]]) });

describe('three way synchronization', () => {
  it('accepts a local-only change', () => {
    const result = reconcile(snap('base'), snap('local'), snap('base'));
    expect(Buffer.from(result.snapshot.files.get(path)!)).toEqual(Buffer.from('local'));
    expect(result.blocked).toBe(false);
  });
  it('accepts a remote-only change', () => {
    const result = reconcile(snap('base'), snap('base'), snap('remote'));
    expect(Buffer.from(result.snapshot.files.get(path)!)).toEqual(Buffer.from('remote'));
    expect(result.blocked).toBe(false);
  });
  it('preserves both edits and blocks publication', () => {
    const result = reconcile(snap('base'), snap('local'), snap('remote'));
    expect(Buffer.from(result.snapshot.files.get(path)!)).toEqual(Buffer.from('local'));
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].preservedPath).toMatch(/^conflicts\/.+\/notes\/.+\.md$/);
    expect(result.blocked).toBe(true);
  });
  it('preserves a delete versus edit as a tombstone/edit conflict at the file level', () => {
    const tombstone = `tombstones/note/${randomUUID()}.json`;
    const base = { files: new Map([[path, Buffer.from('base')]]) };
    const local = { files: new Map([[tombstone, Buffer.from('deleted')]]) };
    const remote = { files: new Map([[path, Buffer.from('edited')]]) };
    const result = reconcile(base, local, remote);
    expect(result.blocked).toBe(true);
    expect(result.snapshot.files.has(tombstone)).toBe(true);
    expect(result.snapshot.files.has(path)).toBe(false);
    expect(result.conflicts).toHaveLength(1);
  });
  it('blocks a remote tombstone against a locally edited original', () => {
    const entityId = randomUUID();
    const tombstone = `tombstones/note/${entityId}.json`;
    const tombstoneBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, entityType: 'note', entityId, originalRelativePath: path, contentHash: 'a'.repeat(64) }));
    const base = { files: new Map([[path, Buffer.from('base')]]) };
    const local = { files: new Map([[path, Buffer.from('local')]]) };
    const remote = { files: new Map([[tombstone, tombstoneBytes]]) };
    const result = reconcile(base, local, remote);
    expect(result.blocked).toBe(true);
    expect(Buffer.from(result.snapshot.files.get(path)!)).toEqual(Buffer.from('local'));
    expect(Buffer.from(result.snapshot.files.get(tombstone)!)).toEqual(tombstoneBytes);
  });
  it('blocks a local tombstone against a remote primary when the common base is empty', () => {
    const entityId = randomUUID();
    const tombstone = `tombstones/note/${entityId}.json`;
    const tombstoneBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, entityType: 'note', entityId, originalRelativePath: path, contentHash: 'a'.repeat(64) }));
    const result = reconcile({ files: new Map() }, { files: new Map([[tombstone, tombstoneBytes]]) }, { files: new Map([[path, Buffer.from('remote primary')]]) }, 'r1');
    expect(result.blocked).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.snapshot.files.has(path)).toBe(false);
    expect(result.snapshot.files.has(tombstone)).toBe(true);
  });
});
