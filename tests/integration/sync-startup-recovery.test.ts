import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Workspace } from '../../server/workspace';
import { serializeEntity } from '../../server/entities';
import type { Entity } from '../../src/shared/types';

const roots: string[] = [];
const opened: Workspace[] = [];
const noteId = '00000000-0000-4000-8000-000000000001';
const notePath = `notes/${noteId}.md`;

const note = (body: string): Buffer => Buffer.from(serializeEntity({
  id: noteId,
  type: 'note',
  schemaVersion: 1,
  title: '同步恢复测试',
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
  revision: 1,
  body,
  paperIds: [],
} satisfies Entity));

async function fixtureRoot() {
  await fs.mkdir('.test-data', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-data/sync-startup-'));
  roots.push(root);
  const workspace = await Workspace.open(root);
  await workspace.close();
  return root;
}

async function writeJournal(root: string, phase: 'prepared' | 'committed', before: Buffer, after: Buffer) {
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await fs.writeFile(path.join(root, 'state/sync-apply.json'), JSON.stringify({
    schemaVersion: 1,
    phase,
    entries: [{
      path: notePath,
      before: before.toString('base64'),
      after: after.toString('base64'),
    }],
  }));
}

afterEach(async () => {
  for (const workspace of opened.splice(0)) await workspace.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('Workspace startup sync journal recovery', () => {
  it('rolls back a prepared partial batch before opening the workspace', async () => {
    const root = await fixtureRoot();
    const before = note('原始内容'), after = note('部分写入');
    await fs.mkdir(path.join(root, 'notes'), { recursive: true });
    await fs.writeFile(path.join(root, notePath), after);
    await writeJournal(root, 'prepared', before, after);

    const workspace = await Workspace.open(root);
    opened.push(workspace);
    expect(await fs.readFile(path.join(root, notePath))).toEqual(before);
    await expect(fs.access(path.join(root, 'state/sync-apply.json'))).rejects.toThrow();
  });

  it('preserves a fully applied committed batch and removes its journal', async () => {
    const root = await fixtureRoot();
    const before = note('原始内容'), after = note('已提交');
    await fs.mkdir(path.join(root, 'notes'), { recursive: true });
    await fs.writeFile(path.join(root, notePath), after);
    await writeJournal(root, 'committed', before, after);

    const workspace = await Workspace.open(root);
    opened.push(workspace);
    expect(await fs.readFile(path.join(root, notePath))).toEqual(after);
    await expect(fs.access(path.join(root, 'state/sync-apply.json'))).rejects.toThrow();
  });

  it('fails closed on a committed journal after an external change', async () => {
    const root = await fixtureRoot();
    const before = note('原始内容'), after = note('应有内容'), external = note('外部改动');
    await fs.mkdir(path.join(root, 'notes'), { recursive: true });
    await fs.writeFile(path.join(root, notePath), external);
    await writeJournal(root, 'committed', before, after);

    await expect(Workspace.open(root)).rejects.toMatchObject({ code: 'SYNC_RECOVERY_REQUIRED' });
    expect(await fs.readFile(path.join(root, notePath))).toEqual(external);
    expect(await fs.readFile(path.join(root, 'state/sync-apply.json'))).toBeTruthy();
  });

  it('does not recover a journal while another writer holds the workspace lock', async () => {
    const root = await fixtureRoot();
    const before = note('原始内容'), after = note('另一批次');
    const writer = await Workspace.open(root);
    opened.push(writer);
    await fs.mkdir(path.join(root, 'notes'), { recursive: true });
    await fs.writeFile(path.join(root, notePath), after);
    await writeJournal(root, 'prepared', before, after);

    await expect(Workspace.open(root)).rejects.toMatchObject({ code: 'SYNC_RECOVERY_REQUIRED' });
    expect(await fs.readFile(path.join(root, notePath))).toEqual(after);
    expect(await fs.readFile(path.join(root, 'state/sync-apply.json'))).toBeTruthy();
  });
});
