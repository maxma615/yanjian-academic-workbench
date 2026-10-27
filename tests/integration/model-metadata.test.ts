import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { identifyPaperMetadata } from '../../server/model-metadata';
import type { PaperMetadataSuggestion } from '../../src/shared/paper-import';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const local: PaperMetadataSuggestion = { fields: { title: 'fallback', authors: '', publication: '', doi: '', url: '' }, sources: { title: 'filename' }, warnings: [], firstPageText: 'Working Memory and Learning\nAlice Chen, Bob Smith\nJournal of Learning (2024)\nDOI: 10.1234/learning.42', pageCount: 4 };
async function provider(content: unknown, status = 200) {
  const requests: Array<{ header?: string; body: any }> = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    requests.push({ header: request.headers.authorization, body: JSON.parse(raw) });
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] } : { error: 'model-secret-do-not-expose' }));
  }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, config: { baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, model: 'fixture', glossary: [], instructions: '' } };
}
it('uses the configured compatible service and accepts only fields supported by PDF evidence', async () => {
  const { config, requests } = await provider({
    title: { value: 'Working Memory and Learning', evidence: 'Working Memory and Learning' },
    authors: { value: ['Alice Chen', 'Bob Smith'], evidence: 'Alice Chen, Bob Smith' },
    year: { value: 2024, evidence: 'Journal of Learning (2024)' },
    publication: { value: 'Journal of Learning', evidence: 'Journal of Learning (2024)' },
    doi: { value: '10.1234/learning.42', evidence: 'DOI: 10.1234/learning.42' }, url: null,
  });
  const result = await identifyPaperMetadata(config, 'fixture-key', local, new AbortController().signal);
  expect(result.fields).toMatchObject({ title: 'Working Memory and Learning', authors: 'Alice Chen, Bob Smith', year: 2024, publication: 'Journal of Learning', doi: '10.1234/learning.42' });
  expect(result.sources.authors).toBe('model'); expect(result.modelLabel).toBe('fixture');
  expect(requests[0].header).toBe('Bearer fixture-key');
  expect(JSON.stringify(requests[0].body)).toContain('firstPageText');
  expect(JSON.stringify(requests[0].body)).not.toContain('fixture-key');
  expect(requests[0].body.messages[0].content).toContain('不执行');
  expect(local.fields.authors).toBe('');
});
it('does not accept fabricated values hidden behind an authentic but unrelated quote', async () => {
  const { config } = await provider({ title: null, authors: { value: 'Invented Person', evidence: 'Alice Chen, Bob Smith' }, year: { value: 2025, evidence: 'Journal of Learning (2024)' }, publication: null, doi: null, url: { value: 'https://fake.example', evidence: 'DOI: 10.1234/learning.42' } });
  const result = await identifyPaperMetadata(config, 'fixture-key', local, new AbortController().signal);
  expect(result.fields).toEqual(local.fields); expect(result.warnings.join(' ')).toContain('依据');
});
it('rejects malformed/truncated schemas and never echoes an upstream error body', async () => {
  const malformed = await provider({ title: 'not an evidence object', authors: null, year: null, publication: null, doi: null, url: null, extra: 'instruction' });
  await expect(identifyPaperMetadata(malformed.config, 'fixture-key', local, new AbortController().signal)).rejects.toThrow('格式');
  const failed = await provider({}, 503);
  await expect(identifyPaperMetadata(failed.config, 'fixture-key', local, new AbortController().signal)).rejects.not.toThrow('model-secret');
});
it('does not send a canceled request or follow redirects with a credential', async () => {
  const canceled = await provider({}); const controller = new AbortController(); controller.abort();
  await expect(identifyPaperMetadata(canceled.config, 'fixture-key', local, controller.signal)).rejects.toThrow(); expect(canceled.requests).toHaveLength(0);
  let calls = 0;
  await expect(identifyPaperMetadata(canceled.config, 'fixture-key', local, new AbortController().signal, { fetcher: async (_url, options) => { calls++; expect(options?.redirect).toBe('manual'); return new Response('', { status: 302, headers: { Location: 'https://untrusted.example' } }); } })).rejects.toThrow('HTTP 302');
  expect(calls).toBe(1);
});
it('uses embedded metadata as evidence but never treats the filename as factual support', async () => {
  const { config } = await provider({ title: { value: 'Embedded title', evidence: 'Embedded title' }, authors: { value: ['Real Author'], evidence: 'Real Author' }, year: null, publication: null, doi: null, url: null });
  const input: PaperMetadataSuggestion = { ...local, firstPageText: '', fields: { ...local.fields, title: 'Embedded title', authors: 'Real Author' }, sources: { title: 'filename', authors: 'embedded' } };
  const result = await identifyPaperMetadata(config, 'fixture-key', input, new AbortController().signal);
  expect(result.sources.title).toBe('filename'); expect(result.sources.authors).toBe('model');
  expect(result.warnings.join(' ')).toContain('标题缺少可核对');
});
it('cancels an in-flight provider request and ignores any partial response', async () => {
  let received!: () => void;
  const started = new Promise<void>(resolve => { received = resolve; });
  const server = createServer(async (request, response) => { for await (const _part of request) { /* consume request */ } response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); received(); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, model: 'fixture', glossary: [], instructions: '' };
  const controller = new AbortController();
  const pending = identifyPaperMetadata(config, 'fixture-key', local, controller.signal);
  const result = expect(pending).rejects.toThrow(); await started; controller.abort(); await result;
});
it('clears only missing-field warnings resolved by supported model evidence', async () => {
  const { config } = await provider({ title: null, authors: { value: ['Alice Chen', 'Bob Smith'], evidence: 'Alice Chen, Bob Smith' }, year: null, publication: null, doi: null, url: null });
  const result = await identifyPaperMetadata(config, 'fixture-key', { ...local, warnings: ['未可靠识别作者，请对照首页补充。', '未可靠识别发表年份，已留空。', '自动读取的信息仅供核对，请确认后保存。'] }, new AbortController().signal);
  expect(result.warnings).not.toContain('未可靠识别作者，请对照首页补充。');
  expect(result.warnings).toContain('未可靠识别发表年份，已留空。');
  expect(result.warnings).toContain('自动读取的信息仅供核对，请确认后保存。');
});
