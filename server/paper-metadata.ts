import path from 'node:path';
import type { PaperMetadataSuggestion } from '../src/shared/paper-import';
import { AppError } from './fs-safe';
import { loadPdfJs } from './translation-engine';

type Line = { text: string; x: number; y: number; width: number; size: number };
const software = /(?:microsoft\s+(?:word|office|powerpoint)|adobe|acrobat|latex|texmaker|libreoffice|ghostscript|pdfcreator|administrator|^admin$|^user$|^unknown$|^untitled|\.docx?$|\.tex$)/i;
const affiliation = /\b(?:department|university|institute|laboratory|faculty|school|college|hospital|centre|center|correspondence|copyright|received|accepted|published|journal|abstract|keywords|introduction)\b|@|https?:|\bdoi\b/i;
const clean = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
function usable(value: unknown, max: number): string { const text = clean(value); return text.length >= 3 && text.length <= max && !software.test(text) ? text : ''; }
function authors(value: unknown, conservative = false): string {
  const text = usable(Array.isArray(value) ? value.join('; ') : value, 1500);
  if (!text || affiliation.test(text)) return '';
  const names = text.replace(/[\d⁰¹²³⁴⁵⁶⁷⁸⁹*†‡§]+/g, '').split(/\s*[,;]\s*|\s+and\s+|\s*&\s*/i).map(part => part.trim()).filter(Boolean);
  if (!names.length || names.length > 30) return '';
  if (conservative && names.some(name => {
    const words = name.split(/\s+/);
    return words.length < 2 || words.length > 6 || !/^[\p{L}\p{M}.'’\- ]+$/u.test(name) || words.some(word => !/^[\p{Lu}\p{Lt}]/u.test(word) && !/^(?:de|del|van|von|der|den|da|dos|di|le|la)$/i.test(word));
  })) return '';
  return names.join(', ');
}
function doi(value: unknown): string {
  const match = clean(value).match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  if (!match) return '';
  let result = match[0].replace(/[.,;:]+$/, '');
  while (result.endsWith(')') && (result.match(/\)/g)?.length ?? 0) > (result.match(/\(/g)?.length ?? 0)) result = result.slice(0, -1);
  return result.length <= 300 ? result : '';
}
function year(value: unknown): number | undefined {
  const result = Number(clean(value).match(/\b(?:18|19|20|21)\d{2}\b/)?.[0]);
  return result >= 1800 && result <= new Date().getFullYear() + 2 ? result : undefined;
}
function pageLines(items: unknown[], viewport: { convertToViewportPoint(x: number, y: number): number[] }): Line[] {
  const fragments: Line[] = [];
  for (const item of items.slice(0, 10000)) {
    if (!item || typeof item !== 'object' || !('str' in item) || !('transform' in item)) continue;
    const value = item as { str: unknown; transform: unknown; width?: unknown; height?: unknown };
    if (!Array.isArray(value.transform)) continue;
    const text = clean(value.str); const size = Math.abs(Number(value.height));
    const [x, y] = viewport.convertToViewportPoint(Number(value.transform[4]), Number(value.transform[5]));
    const width = Math.abs(Number(value.width));
    if (!text || ![size, x, y, width].every(Number.isFinite)) continue;
    // Separate superscript affiliation markers do not belong in the bibliographic byline.
    if (/^[\d⁰¹²³⁴⁵⁶⁷⁸⁹*†‡§]+$/.test(text) && size < 9) continue;
    fragments.push({ text, size, x, y, width });
  }
  fragments.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Line[][] = [];
  for (const fragment of fragments) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].y - fragment.y) <= Math.min(row[0].size, fragment.size) * .4) row.push(fragment);
    else rows.push([fragment]);
  }
  return rows.map(row => {
    row.sort((a, b) => a.x - b.x);
    const line = { ...row[0] };
    for (const part of row.slice(1)) {
      const gap = part.x - (line.x + line.width);
      line.text += `${gap > line.size * 3 ? ', ' : gap > line.size * .1 ? ' ' : ''}${part.text}`;
      line.width = Math.max(line.width, part.x + part.width - line.x); line.size = Math.max(line.size, part.size);
    }
    return line;
  });
}

/** Read local document content as data; this never calls a model or opens PDF links/actions. */
export async function inspectPaperPdf(bytes: Uint8Array, filename: string): Promise<PaperMetadataSuggestion> {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 50 * 1024 * 1024) throw new AppError('请选择不超过 50 MB 的有效 PDF。', 400, 'PAPER_PDF_INVALID');
  let task: ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | undefined;
  try {
    const { library, assets } = await loadPdfJs();
    task = library.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, enableXfa: false,
      isOffscreenCanvasSupported: false, isImageDecoderSupported: false, verbosity: 0,
      cMapUrl: path.join(assets, 'cmaps') + path.sep, cMapPacked: true,
      standardFontDataUrl: path.join(assets, 'standard_fonts') + path.sep, wasmUrl: path.join(assets, 'wasm') + path.sep });
    const document = await task.promise;
    const { info, metadata } = await document.getMetadata();
    const pdfInfo = info as Record<string, unknown>;
    const xmp = (key: string) => metadata?.get(key);
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const lines = pageLines((await page.getTextContent()).items, viewport);
    const firstPageText = lines.map(line => line.text).join('\n').slice(0, 12000);
    page.cleanup();
    const result: PaperMetadataSuggestion = { fields: { title: '', authors: '', publication: '', doi: '', url: '' }, sources: {}, warnings: [], firstPageText, pageCount: document.numPages };
    const { fields, sources, warnings } = result;
    fields.title = usable(xmp('dc:title'), 500) || usable(pdfInfo.Title, 500);
    fields.authors = authors(xmp('dc:creator')) || authors(pdfInfo.Author);
    fields.publication = usable(xmp('prism:publicationname'), 500);
    fields.year = year(xmp('prism:publicationdate')) ?? year(xmp('dc:date'));
    fields.doi = doi(xmp('prism:doi')) || doi(xmp('dc:identifier')) || doi(pdfInfo.DOI);
    for (const key of ['title', 'authors', 'publication', 'year', 'doi'] as const) if (fields[key]) sources[key] = 'embedded';

    const stop = lines.findIndex(line => /^(?:abstract|keywords|introduction|摘要)\b/i.test(line.text));
    const header = lines.slice(0, stop < 0 ? lines.length : stop).filter(line => line.y < viewport.height * .65);
    const candidates = header.filter(line => line.text.length >= 8 && line.text.length < 500 && !affiliation.test(line.text) && !/^\d+$/.test(line.text));
    const largest = Math.max(0, ...candidates.map(line => line.size));
    const first = candidates.find(line => line.size === largest);
    let lastTitleY = first?.y ?? 0;
    if (!fields.title && first) {
      const titleLines = [first];
      for (const line of candidates.filter(line => line.y > first.y)) {
        if (Math.abs(line.size - largest) > 1 || line.y - lastTitleY > largest * 2.2) break;
        titleLines.push(line); lastTitleY = line.y;
      }
      fields.title = titleLines.map(line => line.text).join(' ').slice(0, 500); sources.title = 'first-page';
    } else if (first) {
      lastTitleY = Math.max(...candidates.filter(line => Math.abs(line.size - largest) <= 1 && line.y - first.y < largest * 4).map(line => line.y));
    }
    if (!fields.authors) {
      const bylines = header.filter(line => line.y > lastTitleY && line.y - lastTitleY < 130 && line.size < largest + 1).map(line => authors(line.text, true)).filter(Boolean);
      if (bylines.length) { fields.authors = bylines.join(', '); sources.authors = 'first-page'; }
    }
    if (!fields.year) {
      for (const line of header) {
        if (!/\b(?:published|publication|copyright|©)\b/i.test(line.text) && !(/\b(?:journal|proceedings|review|transactions)\b/i.test(line.text) && /\((?:19|20)\d{2}\)/.test(line.text))) continue;
        fields.year = year(line.text);
        if (fields.year) { sources.year = 'first-page'; break; }
      }
    }
    if (!fields.doi) {
      const referenceStart = lines.findIndex(line => /^references\b/i.test(line.text));
      fields.doi = doi(lines.slice(0, referenceStart < 0 ? lines.length : referenceStart).map(line => line.text).join('\n'));
      if (fields.doi) sources.doi = 'first-page';
    }
    if (fields.doi) { fields.url = `https://doi.org/${fields.doi}`; sources.url = sources.doi; }
    if (!fields.title) { fields.title = clean(filename.split(/[\\/]/).at(-1)).replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 500) || '未命名文献'; sources.title = 'filename'; warnings.push('未可靠识别标题，暂用文件名，请核对。'); }
    if (!fields.authors) warnings.push('未可靠识别作者，请对照首页补充。');
    if (!fields.year) warnings.push('未可靠识别发表年份，已留空。');
    if (!firstPageText) warnings.push('首页没有可提取文字，可能为扫描件；未执行 OCR，可先保存并阅读原 PDF。');
    warnings.push('自动读取的信息仅供核对，请确认后保存。');
    return result;
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError('无法读取 PDF，请检查文件是否损坏或受密码保护。', 400, 'PAPER_PDF_INVALID');
  } finally { if (task) await task.destroy().catch(() => {}); }
}
