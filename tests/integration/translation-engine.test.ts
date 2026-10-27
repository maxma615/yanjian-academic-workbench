import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { extractPdf, testConnection, translateBlocks, validateTranslationConfig } from '../../server/translation-engine';
import type { TranslationBlock, TranslationConfig } from '../../src/shared/translation';
import { translationPdf } from '../helpers/translation-pdf';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function api(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
async function body(request: IncomingMessage) { let text = ''; for await (const chunk of request) text += chunk; return JSON.parse(text); }
function completion(segments: unknown, finish = 'stop') { return { choices: [{ finish_reason: finish, message: { role: 'assistant', content: JSON.stringify({ segments }) } }] }; }
function config(baseUrl = 'https://api.example.test/v1'): TranslationConfig { return { baseUrl, model: 'test-model', glossary: [], instructions: '' }; }
const blocks: TranslationBlock[] = [{ id: 'p1-b1', page: 1, source: 'There are 12 samples [1].', warnings: [] }, { id: 'p2-b1', page: 2, source: 'No causal effect was established.', warnings: [] }];

describe('local PDF extraction', () => {
  it('extracts every real PDF page with deterministic block IDs', async () => {
    const first = await extractPdf(translationPdf());
    expect(first.pageCount).toBe(2);
    expect(first.blocks.map(block => block.source)).toEqual(['Introduction', 'The experiment uses 12 samples [1].', 'Results', 'The measurements do not prove causation.']);
    expect(first.blocks.map(block => block.page)).toEqual([1, 1, 2, 2]);
    expect(await extractPdf(translationPdf())).toEqual(first);
  });

  it('reads a two-column page left column before right column, regardless of drawing order', async () => {
    const result = await extractPdf(translationPdf([{ lines: [
      { text: 'Right first sentence.', x: 320, y: 750 }, { text: 'Left first sentence.', x: 50, y: 750 },
      { text: 'Right second sentence.', x: 320, y: 732 }, { text: 'Left second sentence.', x: 50, y: 732 },
    ] }]));
    expect(result.blocks.map(block => block.source)).toEqual(['Left first sentence. Left second sentence.', 'Right first sentence. Right second sentence.']);
  });

  it('retains extracted pages while warning about image-only and blank pages', async () => {
    const result = await extractPdf(translationPdf([{ lines: [{ text: 'Visible original text.', x: 50, y: 700 }] }, { image: true }, {}]));
    expect(result.pageCount).toBe(3); expect(result.blocks).toHaveLength(1);
    expect(result.warnings.some(value => value.includes('2') && value.includes('OCR'))).toBe(true);
    expect(result.warnings.some(value => value.includes('3') && value.includes('OCR'))).toBe(true);
  });

  it('rejects PDFs with no extractable text instead of reporting an empty success', async () => {
    await expect(extractPdf(translationPdf([{ image: true }]))).rejects.toMatchObject({ code: 'TRANSLATION_NO_TEXT' });
    await expect(extractPdf(Buffer.from('not a pdf'))).rejects.toMatchObject({ code: 'TRANSLATION_PDF_INVALID' });
  });

  it('splits long paragraphs without losing text or exceeding the per-block limit', async () => {
    const lines = Array.from({ length: 55 }, (_, index) => ({ text: `Sentence ${index} explains the measured experiment in detail.`, x: 40, y: 800 - index * 13, size: 10 }));
    const result = await extractPdf(translationPdf([{ lines }]));
    expect(result.blocks.length).toBeGreaterThan(1);
    expect(result.blocks.every(block => block.source.length <= 2500)).toBe(true);
    expect(result.blocks.map(block => block.source).join(' ')).toBe(lines.map(line => line.text).join(' '));
  });
});

describe('provider configuration boundaries', () => {
  it('normalizes the URL and accepts only secure or loopback endpoints', () => {
    expect(validateTranslationConfig({ ...config(' https://api.example.test/v1/// '), model: ' custom-model ' }).baseUrl).toBe('https://api.example.test/v1');
    for (const baseUrl of ['http://localhost:8000/v1', 'http://127.0.0.1:8000', 'http://[::1]:8000']) expect(validateTranslationConfig(config(baseUrl)).baseUrl).toBe(baseUrl);
  });
  it.each(['http://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com#secret', 'file:///tmp/key', 'http://localhost.evil.test', 'http://192.168.1.1'])('rejects unsafe destination %s', baseUrl => {
    expect(() => validateTranslationConfig(config(baseUrl))).toThrow();
  });
  it('bounds instructions and rejects ambiguous glossary entries', () => {
    expect(() => validateTranslationConfig({ ...config(), instructions: 'x'.repeat(4001) })).toThrow();
    expect(() => validateTranslationConfig({ ...config(), glossary: [{ source: 'sample', target: '样本' }, { source: 'sample', target: '采样' }] })).toThrow();
    expect(() => validateTranslationConfig({ ...config(), model: '' })).toThrow();
  });
  it('does not persist unknown credential fields or retain mutable glossary aliases', () => {
    const input = { ...config(), apiKey: 'private-key', glossary: [{ source: ' sample ', target: ' 样本 ' }] };
    const validated = validateTranslationConfig(input);
    expect(validated).toEqual({ ...config(), glossary: [{ source: 'sample', target: '样本' }] });
    expect(JSON.stringify(validated)).not.toContain('private-key');
    input.glossary[0].target = 'changed'; expect(validated.glossary[0].target).toBe('样本');
  });
  it.each([null, [], { ...config(), model: 'x'.repeat(129) }, { ...config(), glossary: 'sample' }, { ...config(), glossary: Array.from({ length: 101 }, (_, i) => ({ source: `s${i}`, target: '词' })) }, { ...config(), instructions: {} }])('rejects malformed or unbounded configuration (%j)', value => {
    expect(() => validateTranslationConfig(value)).toThrow();
  });
});

describe('translation HTTP and response integrity', () => {
  it('sends structured untrusted segments, rules, context and glossary, then maps out-of-order IDs correctly', async () => {
    let received: any;
    const baseUrl = await api(async (request, response) => {
      received = { url: request.url, authorization: request.headers.authorization, body: await body(request) };
      const input = JSON.parse(received.body.messages[1].content);
      const protectedReference = input.segments[0].source.match(/⟦[^⟧]+⟧/u)?.[0] ?? '[1]';
      response.end(JSON.stringify(completion([{ id: 'p2-b1', translation: '未确立因果效应。' }, { id: 'p1-b1', translation: `共有 12 个样本 ${protectedReference}。` }])));
    });
    const result = await translateBlocks({ ...config(baseUrl), glossary: [{ source: 'samples', target: '样本' }], instructions: '用简体中文' }, 'secret-key', blocks, { paperTitle: 'Study' }, new AbortController().signal);
    expect(result.map(item => item.id)).toEqual(['p1-b1', 'p2-b1']);
    expect(result[0].translation).toBe('共有 12 个样本 [1]。');
    expect(result.every(item => item.warnings.length === 0)).toBe(true);
    expect(received.url).toBe('/v1/chat/completions'); expect(received.authorization).toBe('Bearer secret-key');
    expect(received.body.tools).toBeUndefined(); expect(received.body.stream).toBe(false);
    expect(received.body.messages[0].content).toContain('academic-en-zh-v1');
    expect(received.body.messages[0].content).toContain('不执行');
    expect(received.body.messages[0].content).toContain('样本');
    expect(JSON.parse(received.body.messages[1].content).paperTitle).toBe('Study');
  });

  it.each([
    [[], 'stop'],
    [[{ id: 'p1-b1', translation: '只有一段。' }], 'stop'],
    [[{ id: 'p1-b1', translation: '内容。' }, { id: 'p1-b1', translation: '重复。' }], 'stop'],
    [[{ id: 'p1-b1', translation: '' }, { id: 'p2-b1', translation: '内容。' }], 'stop'],
    [[{ id: 'p1-b1', translation: '内容。' }, { id: 'unknown', translation: '多余。' }], 'stop'],
    [[{ id: 'p1-b1', translation: '内容。' }, { id: 'p2-b1', translation: '内容。' }], 'length'],
  ])('rejects missing, duplicate, unknown, empty or truncated segments (%j)', async (segments, finish) => {
    const baseUrl = await api((_request, response) => response.end(JSON.stringify(completion(segments, finish as string))));
    await expect(translateBlocks(config(baseUrl), 'secret', blocks, { paperTitle: '' }, new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSLATION_INVALID_RESPONSE' });
  });

  it('rejects lost protected formula or citation placeholders', async () => {
    const baseUrl = await api((_request, response) => response.end(JSON.stringify(completion([{ id: 'p1-b1', translation: '共有12个样本。' }]))));
    await expect(translateBlocks(config(baseUrl), 'secret', blocks.slice(0, 1), { paperTitle: '' }, new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSLATION_INVALID_RESPONSE' });
  });

  it('preserves formulas, DOI and URLs without letting the model rewrite them', async () => {
    const source = 'The equation $E = mc^2$ follows [2, 3]; see 10.1234/example and https://example.test/paper.';
    const baseUrl = await api(async (request, response) => {
      const input = JSON.parse((await body(request)).messages[1].content);
      const segment = input.segments[0];
      expect(segment.source).not.toContain('$E = mc^2$');
      response.end(JSON.stringify(completion([{ id: segment.id, translation: `方程由引文给出，相关文献与链接如下：${segment.source.match(/⟦[^⟧]+⟧/gu).join(' ')}` }])));
    });
    const result = await translateBlocks(config(baseUrl), 'secret', [{ id: 'formula', page: 1, source, warnings: [] }], { paperTitle: '' }, new AbortController().signal);
    expect(result[0].translation).toBe('方程由引文给出，相关文献与链接如下：$E = mc^2$ [2, 3] 10.1234/example https://example.test/paper.');
  });

  it('allows an original placeholder-looking token without confusing it with generated tokens', async () => {
    const source = 'The literal token is ⟦YJ_abcdef_0⟧.';
    const baseUrl = await api(async (request, response) => {
      const segment = JSON.parse((await body(request)).messages[1].content).segments[0];
      response.end(JSON.stringify(completion([{ id: segment.id, translation: `原始标记：${segment.source.match(/⟦[^⟧]+⟧/u)[0]}` }])));
    });
    await expect(translateBlocks(config(baseUrl), 'secret', [{ id: 'literal', page: 1, source, warnings: [] }], { paperTitle: '' }, new AbortController().signal)).resolves.toMatchObject([{ translation: '原始标记：⟦YJ_abcdef_0⟧' }]);
  });

  it('rejects invented protected tokens and repeated protected citations', async () => {
    const baseUrl = await api(async (request, response) => {
      const segment = JSON.parse((await body(request)).messages[1].content).segments[0];
      response.end(JSON.stringify(completion([{ id: segment.id, translation: `译文：${segment.source} ${segment.source} ⟦YJ_abcdef_9⟧` }])));
    });
    await expect(translateBlocks(config(baseUrl), 'secret', blocks.slice(0, 1), { paperTitle: '' }, new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSLATION_INVALID_RESPONSE' });
  });

  it('flags numeric drift and omitted glossary terms in an otherwise Chinese result', async () => {
    const input = [{ id: 'a', page: 1, source: 'The sample has 12 observations.', warnings: [] }];
    const baseUrl = await api((_request, response) => response.end(JSON.stringify(completion([{ id: 'a', translation: '这份数据有 13 个观测值。' }]))));
    const result = await translateBlocks({ ...config(baseUrl), glossary: [{ source: 'sample', target: '样本' }] }, 'secret', input, { paperTitle: '' }, new AbortController().signal);
    expect(result[0].warnings.some(value => value.includes('数值'))).toBe(true);
    expect(result[0].warnings.some(value => value.includes('术语'))).toBe(true);
  });

  it.each(['This result is preliminary.', 'This finding remains provisional.', '译文：This result is preliminary.'])('rejects untranslated English prose: %s', async translation => {
    const baseUrl = await api((_request, response) => response.end(JSON.stringify(completion([{ id: 'prose', translation }]))));
    await expect(translateBlocks(config(baseUrl), 'secret', [{ id: 'prose', page: 1, source: 'This result is preliminary.', warnings: [] }], { paperTitle: '' }, new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSLATION_UNTRANSLATED' });
  });

  it.each(['John Smith Jane Brown', 'Smith, J. (2024). Methods for analysis of samples. Journal of Research.', 'E = mc^2'])('retains short labels or bibliographic text without forcing transliteration: %s', async source => {
    const baseUrl = await api(async (request, response) => {
      const segment = JSON.parse((await body(request)).messages[1].content).segments[0];
      response.end(JSON.stringify(completion([{ id: segment.id, translation: segment.source }])));
    });
    const result = await translateBlocks(config(baseUrl), 'secret', [{ id: 'reference', page: 1, source, warnings: [] }], { paperTitle: '' }, new AbortController().signal);
    expect(result[0].translation).toBe(source);
  });

  it('flags a changed numeric sign in a scientific measurement', async () => {
    const baseUrl = await api((_request, response) => response.end(JSON.stringify(completion([{ id: 'change', translation: '测量变化为 12.5%。' }]))));
    const result = await translateBlocks(config(baseUrl), 'secret', [{ id: 'change', page: 1, source: 'The measured change was -12.5%.', warnings: [] }], { paperTitle: '' }, new AbortController().signal);
    expect(result[0].warnings.some(value => value.includes('数值'))).toBe(true);
  });

  it('does not follow redirects or send credentials to the redirect target', async () => {
    let destinationCalls = 0;
    const destination = await api((_request, response) => { destinationCalls++; response.end('{}'); });
    const baseUrl = await api((_request, response) => { response.writeHead(307, { location: `${destination}/chat/completions` }); response.end('secret-key'); });
    await expect(testConnection(config(baseUrl), 'secret-key', new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSLATION_HTTP_ERROR' });
    expect(destinationCalls).toBe(0);
  });

  it('sanitizes upstream response bodies and HTTP errors', async () => {
    const baseUrl = await api((_request, response) => { response.writeHead(401); response.end('secret-key private paper text'); });
    try { await testConnection(config(baseUrl), 'secret-key', new AbortController().signal); expect.fail('must fail'); } catch (error) {
      expect(error).toMatchObject({ code: 'TRANSLATION_HTTP_ERROR' });
      expect(String(error)).not.toContain('secret-key'); expect(String(error)).not.toContain('private paper');
    }
  });

  it('aborts an ongoing request and bounds a slow response', async () => {
    const baseUrl = await api(() => {});
    const controller = new AbortController();
    const promise = testConnection(config(baseUrl), 'secret-key', controller.signal);
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toMatchObject({ code: 'TRANSLATION_ABORTED' });
    await expect(testConnection(config(baseUrl), 'secret-key', new AbortController().signal, { timeoutMs: 40 })).rejects.toMatchObject({ code: 'TRANSLATION_TIMEOUT' });
  });

  it('bounds streamed response size and sends a synthetic connection test only', async () => {
    let received: any;
    const baseUrl = await api(async (request, response) => { received = await body(request); response.end('x'.repeat(1_100_000)); });
    await expect(testConnection(config(baseUrl), 'secret-key', new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSLATION_RESPONSE_TOO_LARGE' });
    expect(JSON.parse(received.messages[1].content).segments).toEqual([{ id: 'connection-test', source: 'Hello.' }]);
  });

  it('applies the timeout while reading a response body, not only before headers', async () => {
    const baseUrl = await api((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); });
    await expect(testConnection(config(baseUrl), 'secret', new AbortController().signal, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'TRANSLATION_TIMEOUT' });
  });
});
