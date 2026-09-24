import { describe, expect, it } from 'vitest';
import { GitHubTransport } from '../../src/sync/github-transport';

function response(body: unknown, status = 200): Response { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response; }

describe('GitHub transport (injected HTTP only)', () => {
  it('reads a private branch tree and blobs without contacting a real account', async () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      if (url.endsWith('/repos/alice/private')) return response({ private: true });
      if (url.includes('/git/ref/heads/main')) return response({ object: { sha: 'commit-1' } });
      if (url.includes('/git/commits/commit-1')) return response({ tree: { sha: 'tree-1' } });
      if (url.includes('/git/trees/tree-1')) return response({ tree: [{ path: 'notes/a.md', type: 'blob', mode: '100644', sha: 'blob-1' }], truncated: false });
      if (url.includes('/git/blobs/blob-1')) return response({ encoding: 'base64', content: Buffer.from('hello').toString('base64') });
      throw new Error(`unexpected URL ${url}`);
    };
    const transport = new GitHubTransport({ destination: { owner: 'alice', repo: 'private', branch: 'main' }, credentials: { getToken: async () => 'fake-token' }, fetch: fetcher, apiBase: 'https://fake.github.test' });
    const snapshot = await transport.readSnapshot();
    expect(snapshot.revision).toBe('commit-1'); expect(Buffer.from(snapshot.files.get('notes/a.md')!).toString()).toBe('hello'); expect(calls.every(url => url.startsWith('https://fake.github.test/'))).toBe(true);
  });

  it('rejects a public repository before reading or publishing content', async () => {
    let calls = 0;
    const transport = new GitHubTransport({ destination: { owner: 'alice', repo: 'public', branch: 'main' }, credentials: { getToken: async () => 'fake-token' }, fetch: async () => { calls++; return response({ private: false }); }, apiBase: 'https://fake.github.test' });
    await expect(transport.readSnapshot()).rejects.toMatchObject({ code: 'SYNC_REPOSITORY_NOT_PRIVATE' });
    expect(calls).toBe(1);
  });

  it('publishes with force false and an expected parent revision', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let count = 0;
    const fetcher = async (url: string, init?: RequestInit) => {
      requests.push({ url, init }); count++;
      if (url.endsWith('/repos/alice/private')) return response({ private: true });
      if (url.includes('/git/commits/old')) return response({ tree: { sha: 'tree-1' } });
      if (url.includes('/git/trees/tree-1')) return response({ tree: [{ path: 'notes/00000000-0000-4000-8000-000000000001.md', type: 'blob', mode: '100644', sha: 'old-blob' }] });
      if (url.includes('/git/blobs/old-blob')) return response({ encoding: 'base64', content: Buffer.from('---\n{"id":"00000000-0000-4000-8000-000000000001","type":"note","schemaVersion":1,"title":"旧","createdAt":"2026-09-23T00:00:00.000Z","updatedAt":"2026-09-23T00:00:00.000Z","revision":1,"paperIds":[]}\n---\n旧').toString('base64') });
      if (url.endsWith('/git/blobs')) return response({ sha: `blob-${count}` });
      if (url.endsWith('/git/trees')) return response({ sha: 'tree-new' });
      if (url.endsWith('/git/commits')) return response({ sha: 'commit-new' });
      if (url.includes('/git/refs/heads/main')) return response({ ok: true });
      throw new Error(`unexpected URL ${url}`);
    };
    const transport = new GitHubTransport({ destination: { owner: 'alice', repo: 'private', branch: 'main' }, credentials: { getToken: async () => 'fake-token' }, fetch: fetcher, apiBase: 'https://fake.github.test' });
    const newPath = 'notes/00000000-0000-4000-8000-000000000002.md';
    const newBytes = Buffer.from('---\n{"id":"00000000-0000-4000-8000-000000000002","type":"note","schemaVersion":1,"title":"新","createdAt":"2026-09-23T00:00:00.000Z","updatedAt":"2026-09-23T00:00:00.000Z","revision":1,"paperIds":[]}\n---\n新');
    expect(await transport.publish(new Map([[newPath, newBytes]]), 'old')).toEqual({ revision: 'commit-new' });
    const update = requests.find(request => request.url.includes('/git/refs/heads/main'))!;
    expect(JSON.parse(String(update.init?.body))).toMatchObject({ sha: 'commit-new', force: false });
    const tree = requests.find(request => request.url.endsWith('/git/trees'))!;
    expect(JSON.parse(String(tree.init?.body)).tree).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'notes/00000000-0000-4000-8000-000000000001.md', sha: null })]));
  });

  it('turns a network abort into a sanitized retryable error', async () => {
    const transport = new GitHubTransport({ destination: { owner: 'alice', repo: 'private', branch: 'main' }, credentials: { getToken: async () => 'secret-token' }, fetch: async () => { throw new Error('secret-token reflected by proxy'); }, apiBase: 'https://fake.github.test' });
    await expect(transport.readSnapshot()).rejects.toMatchObject({ code: 'SYNC_RETRYABLE', status: 503 });
    await expect(transport.readSnapshot()).rejects.not.toThrow('secret-token');
  });
});
