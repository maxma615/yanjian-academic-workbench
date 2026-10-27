import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minus, Plus, RotateCw } from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist/types/src/display/api';
import type { TextLayer } from 'pdfjs-dist';
import * as api from './api';
import './pdf-reader.css';

export interface PdfReaderProps {
  paperId?: string;
  attachmentId?: string;
  blob?: Blob;
  pageNumber: number;
  onPageCount: (count: number) => void;
  onPageChange?: (page: number) => void;
}

/** A local PDF page renderer. It never builds annotation links or runs PDF scripts. */
export function PdfReader({ paperId, attachmentId, blob, pageNumber, onPageCount, onPageChange }: PdfReaderProps) {
  const [pdf, setPdf] = useState<{ source: string | Blob; document: PDFDocumentProxy }>();
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [textWarning, setTextWarning] = useState('');
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [actualScale, setActualScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [availableWidth, setAvailableWidth] = useState(600);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onPageCount, onPageChange });
  callbacks.current = { onPageCount, onPageChange };
  const source = blob || `${paperId}/${attachmentId}`;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setAvailableWidth(Math.max(120, viewport.clientWidth - 32));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    let task: PDFDocumentLoadingTask | undefined;
    setPdf(undefined); setLoading(true); setRendering(false); setError(''); setTextWarning('');
    setZoom('fit'); setRotation(0); callbacks.current.onPageCount(0);
    void (async () => {
      try {
        if (!blob && (!paperId || !attachmentId)) throw new Error('没有可显示的 PDF');
        const [module, pdfBlob] = await Promise.all([import('pdfjs-dist'), blob ? Promise.resolve(blob) : api.getPdf(paperId!, attachmentId!, controller.signal)]);
        if (disposed) return;
        const data = new Uint8Array(await pdfBlob.arrayBuffer());
        if (disposed) return;
        module.GlobalWorkerOptions.workerSrc = '/pdfjs-assets/pdf.worker.min.mjs';
        task = module.getDocument({
          data, cMapUrl: '/pdfjs-assets/cmaps/', cMapPacked: true,
          standardFontDataUrl: '/pdfjs-assets/standard_fonts/',
          wasmUrl: '/pdfjs-assets/wasm/', iccUrl: '/pdfjs-assets/iccs/',
          useWorkerFetch: true, useSystemFonts: false, enableXfa: false,
        });
        const document = await task.promise;
        if (disposed) return;
        setPdf({ source, document }); callbacks.current.onPageCount(document.numPages);
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error && caught.name === 'PasswordException'
          ? '这份 PDF 需要密码，请先用系统阅读器解锁后重新导入。'
          : '暂时无法显示这份 PDF。可以重试，或用系统阅读器打开原文件。');
      } finally { if (!disposed) setLoading(false); }
    })();
    return () => { disposed = true; controller.abort(); void task?.destroy().catch(() => {}); };
  }, [paperId, attachmentId, blob, source, retry]);

  useEffect(() => {
    const host = sheetRef.current;
    if (!host) return;
    host.replaceChildren();
    if (!pdf || pdf.source !== source) return;
    let disposed = false;
    let renderTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    setRendering(true); setError(''); setTextWarning('');
    const currentPage = Math.min(pdf.document.numPages, Math.max(1, Math.trunc(pageNumber) || 1));
    if (currentPage !== pageNumber) callbacks.current.onPageChange?.(currentPage);
    void (async () => {
      try {
        const page = await pdf.document.getPage(currentPage);
        if (disposed) return;
        const orientation = (page.rotate + rotation) % 360;
        const original = page.getViewport({ scale: 1, rotation: orientation });
        const scale = zoom === 'fit' ? Math.min(3, availableWidth / original.width) : zoom;
        const viewport = page.getViewport({ scale, rotation: orientation });
        setActualScale(scale);
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2,
          Math.sqrt(16_000_000 / Math.max(1, viewport.width * viewport.height)),
          16_384 / Math.max(1, viewport.width, viewport.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
        canvas.dataset.testid = 'pdf-page-canvas'; canvas.dataset.page = String(currentPage);
        canvas.dataset.rendered = 'false'; canvas.setAttribute('aria-label', `PDF 原文，第 ${currentPage} 页`);
        canvas.setAttribute('role', 'img');
        const sheet = document.createElement('div'); sheet.className = 'pdf-page-sheet';
        sheet.style.width = `${viewport.width}px`; sheet.style.height = `${viewport.height}px`;
        sheet.style.setProperty('--total-scale-factor', String(scale * page.userUnit));
        const textContainer = document.createElement('div'); textContainer.className = 'pdf-reader-text-layer';
        sheet.append(canvas, textContainer); host.replaceChildren(sheet);
        renderTask = page.render({ canvas, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
        await renderTask.promise;
        if (disposed) return;
        canvas.dataset.rendered = 'true';
        // Text selection is a separate local layer; failure must not hide the page image.
        try {
          const [content, module] = await Promise.all([page.getTextContent(), import('pdfjs-dist')]);
          if (disposed) return;
          textLayer = new module.TextLayer({ textContentSource: content, container: textContainer, viewport });
          await textLayer.render();
        } catch {
          if (!disposed) { textContainer.replaceChildren(); setTextWarning('本页文字暂时不能选取，原始页面仍可阅读。'); }
        }
      } catch (caught) {
        if (!disposed && (!(caught instanceof Error) || caught.name !== 'RenderingCancelledException'))
          setError('这一页暂时无法显示。请重试或打开原文件核对。');
      } finally { if (!disposed) setRendering(false); }
    })();
    return () => { disposed = true; renderTask?.cancel(); textLayer?.cancel(); host.replaceChildren(); };
  }, [pdf, source, pageNumber, zoom, rotation, availableWidth]);

  const adjustZoom = (factor: number) => setZoom(Math.max(0.25, Math.min(3, actualScale * factor)));
  return <section className="pdf-reader" aria-label="PDF 原文阅读器">
    <div className="pdf-reader-controls">
      <span className="pdf-reader-label">原始版式</span>
      <div className="pdf-reader-zoom" role="group" aria-label="原文显示设置">
        <button type="button" aria-label="缩小原文" disabled={loading || actualScale <= 0.25} onClick={() => adjustZoom(0.8)}><Minus size={15} /></button>
        <output aria-label="原文缩放比例">{Math.round(actualScale * 100)}%</output>
        <button type="button" aria-label="放大原文" disabled={loading || actualScale >= 3} onClick={() => adjustZoom(1.25)}><Plus size={15} /></button>
        <button type="button" className={zoom === 'fit' ? 'selected' : ''} disabled={loading} onClick={() => setZoom('fit')}><Maximize2 size={14} /><span>适应宽度</span></button>
        <button type="button" aria-label="顺时针旋转原文" disabled={loading} onClick={() => setRotation(value => (value + 90) % 360)}><RotateCw size={15} /></button>
      </div>
    </div>
    {error && <div className="pdf-reader-error" role="alert"><span>{error}</span><button type="button" className="button tiny" onClick={() => setRetry(value => value + 1)}>重试显示</button></div>}
    <div className="pdf-reader-viewport" ref={viewportRef} aria-busy={loading || rendering}>
      {(loading || rendering) && <p className="pdf-reader-loading" role="status">{loading ? '正在打开原文…' : `正在显示第 ${pageNumber} 页…`}</p>}
      <div className="pdf-reader-page-host" ref={sheetRef} />
    </div>
    {textWarning && <p className="pdf-reader-text-warning">{textWarning}</p>}
  </section>;
}
