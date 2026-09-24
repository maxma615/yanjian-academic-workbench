import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { verifyBackup } from '../../src/backup/backup-service';

function archive(entries: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, new TextEncoder().encode(value)])));
}

describe('backup archive safety', () => {
  it.each(['../escape.md', '/absolute.md', 'C:/drive.md', 'folder\\escape.md', 'NUL.txt', 'notes/./x.md', 'notes/a:b.md', 'notes/a<b.md', 'notes/a"b.md', 'notes/a|b.md', 'notes/a?b.md', 'notes/a*b.md', 'notes/a\u0001b.md'])('rejects unsafe member path %s before unpacking', name => {
    expect(() => verifyBackup(archive({ [name]: 'x', 'manifest.json': JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), files: [] }) }))).toThrow(/unsafe|reserved|manifest/i);
  });

  it('rejects a checksum mismatch before exposing files', () => {
    const bytes = archive({ 'notes/n.md': 'actual', 'manifest.json': JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), files: [{ path: 'notes/n.md', byteSize: 7, sha256: '0'.repeat(64) }] }) });
    expect(() => verifyBackup(bytes)).toThrow(/checksum/i);
  });

  it('rejects non-whitelisted state and credential entries even when their manifest is valid', () => {
    const bytes = archive({ 'state/local-settings.json': 'secret', 'manifest.json': JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), files: [{ path: 'state/local-settings.json', byteSize: 6, sha256: '0'.repeat(64) }] }) });
    expect(() => verifyBackup(bytes)).toThrow(/whitelist|path|checksum/i);
  });

  it('rejects central directory size inflation before decompression', () => {
    const bytes = archive({ 'workspace.json': '{"schemaVersion":1}', 'manifest.json': JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), files: [{ path: 'workspace.json', byteSize: 18, sha256: '0'.repeat(64) }] }) });
    const mutated = new Uint8Array(bytes);
    for (let i = mutated.length - 22; i >= 0; i--) {
      if (mutated[i] === 0x50 && mutated[i + 1] === 0x4b && mutated[i + 2] === 0x01 && mutated[i + 3] === 0x02) {
        mutated[i + 24] = 0xff; mutated[i + 25] = 0xff; mutated[i + 26] = 0xff; mutated[i + 27] = 0xff; break;
      }
    }
    expect(() => verifyBackup(mutated)).toThrow(/large|size|checksum|unsupported/i);
  });

  it('rejects a decomposed ZIP name when its normalized key differs from the raw member', () => {
    const name = 'notes/e\u0301.md';
    const bytes = archive({ [name]: 'x', 'workspace.json': '{"schemaVersion":1}', 'manifest.json': JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), files: [{ path: name, byteSize: 1, sha256: '0'.repeat(64) }, { path: 'workspace.json', byteSize: 18, sha256: '0'.repeat(64) }] }) });
    expect(() => verifyBackup(bytes)).toThrow(/normalized|path|checksum/i);
  });
});
