import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, FileText, RefreshCw, Upload, X } from 'lucide-react';
import type { PaperImportFields, PaperMetadataSource, PaperMetadataSuggestion, PaperPdfImportRequest } from '../shared/paper-import';
import type { SaveResult } from '../shared/types';
import type { TranslationConfig, TranslationSettings } from '../shared/translation';
import * as api from './api';
import { PdfReader } from './PdfReader';
import './paper-import.css';

const sourceLabels: Record<PaperMetadataSource, string> = {
  embedded: '来自 PDF 信息', 'first-page': '来自首页文字', filename: '使用文件名，待核对', model: '由模型识别，待核对',
};
function readFile(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => { reader.abort(); reject(new DOMException('已取消', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    reader.onload = () => { signal.removeEventListener('abort', abort); resolve(String(reader.result).split(',')[1] || ''); };
    reader.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error('无法读取这个文件，请重新选择。')); };
    if (signal.aborted) abort(); else reader.readAsDataURL(file);
  });
}
const configOf = ({ baseUrl, model, glossary, instructions }: TranslationSettings): TranslationConfig => ({ baseUrl, model, glossary, instructions });

export function PaperImportModal({ workspaceId, dataDirectory, onClose, onSaved, onSettings }: {
  workspaceId: string; dataDirectory: string; onClose: () => void;
  onSaved: (result: SaveResult) => void; onSettings: () => void;
}) {
  const [selected, setSelected] = useState<{ file: File; base64: string; requestId: string }>();
  const [suggestion, setSuggestion] = useState<PaperMetadataSuggestion>();
  const [fields, setFields] = useState<PaperImportFields>();
  const [year, setYear] = useState('');
  const [settings, setSettings] = useState<TranslationSettings>();
  const [settingsState, setSettingsState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [reading, setReading] = useState(false), [saving, setSaving] = useState(false);
  const [uncertainSave, setUncertainSave] = useState(false);
  const [error, setError] = useState(''), [dragging, setDragging] = useState(false);
  const [page, setPage] = useState(1), [pageCount, setPageCount] = useState(0);
  const dialog = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0), controller = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true), savingRef = useRef(false), closeRef = useRef(onClose);
  const settingsRequest = useRef<Promise<TranslationSettings | undefined> | undefined>(undefined);
  const pendingSave = useRef<PaperPdfImportRequest | undefined>(undefined);
  closeRef.current = onClose;
  useEffect(() => {
    alive.current = true;
    settingsRequest.current = api.translationSettings().then(value => {
      if (alive.current) { setSettings(value); setSettingsState('ready'); } return value;
    }).catch(() => { if (alive.current) setSettingsState('failed'); return undefined; });
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!savingRef.current) closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href]') || []).filter(item => item.tabIndex !== -1 && item.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { alive.current = false; ++sequence.current; controller.current?.abort(); document.removeEventListener('keydown', keyboard); previous?.focus(); };
  }, []);

  const selectFile = async (files: FileList | File[]) => {
    if (savingRef.current || uncertainSave) return;
    controller.current?.abort(); const version = ++sequence.current;
    const abort = new AbortController(); controller.current = abort;
    setError(''); setSuggestion(undefined); setFields(undefined); setSelected(undefined); setYear('');
    setPage(1); setPageCount(0); pendingSave.current = undefined;
    if (files.length !== 1) { setReading(false); setError('请一次选择一份 PDF。'); return; }
    const file = files[0];
    if (!/\.pdf$/i.test(file.name) || file.size > 50 * 1024 * 1024 || !file.size) {
      setReading(false); setError('请选择不超过 50 MB 的 PDF 文件。'); return;
    }
    setReading(true);
    try {
      const [base64, configured] = await Promise.all([readFile(file, abort.signal), settingsRequest.current]);
      if (!alive.current || version !== sequence.current) return;
      setSelected({ file, base64, requestId: crypto.randomUUID() });
      const expectedConfig = configured?.hasApiKey && !configured.keyError ? configOf(configured) : undefined;
      const result = await api.inspectPaperPdf({ name: file.name, base64, expectedConfig }, abort.signal);
      if (!alive.current || version !== sequence.current) return;
      setSuggestion(result); setFields(result.fields); setYear(result.fields.year ? String(result.fields.year) : '');
    } catch (caught) {
      if (alive.current && version === sequence.current && !abort.signal.aborted) setError(caught instanceof Error ? caught.message : '读取失败，请更换文件后再试。');
    } finally { if (alive.current && version === sequence.current) setReading(false); }
  };
  const save = async () => {
    if (savingRef.current || !fields || !selected || reading) return;
    if (!fields.title.trim()) { setError('请核对并填写文献标题。'); return; }
    if (year && (!/^\d{4}$/.test(year) || Number(year) < 1000 || Number(year) > 9999)) { setError('年份请填写四位数字，不确定可以留空。'); return; }
    savingRef.current = true; setSaving(true); setError('');
    pendingSave.current ||= { workspaceId, dataDirectory, requestId: selected.requestId, name: selected.file.name, base64: selected.base64, fields: { ...fields, title: fields.title.trim(), year: year ? Number(year) : undefined } };
    try {
      const result = await api.importPaperPdf(pendingSave.current);
      if (alive.current) onSaved(result);
    } catch (caught) {
      if (!alive.current) return;
      if (caught instanceof api.ApiError) { pendingSave.current = undefined; setUncertainSave(false); setError(caught.message); }
      else { setUncertainSave(true); setError('暂时未收到保存结果，已保留核对信息。请重试确认，系统不会重复添加。'); }
    } finally { savingRef.current = false; if (alive.current) setSaving(false); }
  };
  const set = (key: keyof PaperImportFields, value: string) => setFields(old => old ? { ...old, [key]: value } : old);
  const sourceHint = (key: keyof PaperImportFields) => suggestion?.sources[key] ? <small className="paper-import-source">{sourceLabels[suggestion.sources[key]!]}</small> : null;
  const configured = settings?.hasApiKey && !settings.keyError;
  const lockFields = saving || uncertainSave;
  return <div className="modal-backdrop paper-import-backdrop">
    <div className={`paper-import-modal${selected ? ' has-file' : ''}`} ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="paper-import-title">
      <div className="modal-head"><div><h2 id="paper-import-title">导入文献</h2><p>{fields ? '信息已读出，核对后就可以开始阅读。' : '放入 PDF，自动读取文献信息。'}</p></div><button className="quiet-icon" aria-label="关闭导入文献" disabled={saving} onClick={onClose}><X size={20} /></button></div>
      <div className="paper-import-body">
        <div className="paper-import-model-note">
          {settingsState === 'loading' ? <span>正在读取模型配置…</span> : configured ? <><strong>{settings.model}</strong><span>识别时将首页文字发送至 {settings.baseUrl}。与全文翻译共用模型配置。</span></> : <span>{settingsState === 'failed' ? '模型配置暂时无法读取，本次先使用本地识别。' : settings?.keyError ? '模型密钥暂时不可用，本次先使用本地识别。' : '尚未配置模型，先从 PDF 本地识别；作者等信息可以手动核对。'}</span>}
          <button type="button" className="text-link" disabled={saving} onClick={onSettings}>模型设置</button>
        </div>
        <input ref={input} className="paper-import-file-input" tabIndex={-1} type="file" accept=".pdf,application/pdf" aria-label="选择 PDF 文件" disabled={saving || uncertainSave} onChange={event => { const files = Array.from(event.target.files || []); event.currentTarget.value = ''; if (files.length) void selectFile(files); }} />
        <div className={`paper-import-drop${selected ? ' compact' : ''}${dragging ? ' dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!saving && !uncertainSave) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void selectFile(event.dataTransfer.files); }}>
          {selected ? <><FileText size={24} /><div className="paper-import-file-name"><strong title={selected.file.name}>{selected.file.name}</strong><span>{(selected.file.size / 1024 / 1024).toFixed(2)} MB · PDF 原文件将保存在本机</span></div><button className="button secondary" disabled={saving || uncertainSave} onClick={() => input.current?.click()}>更换 PDF</button></> : <><Upload size={30} /><h3>把论文 PDF 拖到这里</h3><p>标题、作者和年份会自动填写，你只需核对。</p><button className="button primary" disabled={saving} onClick={() => input.current?.click()}>选择 PDF</button><small>每次一份，最大 50 MB</small></>}
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        {reading && <p className="paper-import-progress" role="status"><RefreshCw size={16} className="spin" />{configured ? '正在读取 PDF 并识别文献信息…' : '正在读取 PDF 文献信息…'}<span>可以取消，或换一份文件。</span></p>}
        {selected && <div className="paper-import-review">
          <section className="paper-import-fields" aria-label="核对文献信息">
            {fields && <><h3>核对信息</h3>{suggestion?.modelLabel && <p className="paper-import-model-result">已使用 {suggestion.modelLabel} 识别，请对照原文确认。</p>}
              <label className="field"><span>标题</span><input aria-label="标题" value={fields.title} disabled={lockFields} onChange={event => set('title', event.target.value)} />{sourceHint('title')}</label>
              <label className="field"><span>作者</span><input aria-label="作者" value={fields.authors} disabled={lockFields} onChange={event => set('authors', event.target.value)} placeholder="未识别时可留空" />{sourceHint('authors')}</label>
              <label className="field paper-import-year"><span>年份</span><input aria-label="年份" inputMode="numeric" maxLength={4} value={year} disabled={lockFields} onChange={event => setYear(event.target.value)} placeholder="可留空" />{sourceHint('year')}</label>
              <details className="paper-import-additional"><summary>补充信息（可选）</summary><div>
                <label className="field"><span>期刊 / 会议</span><input aria-label="期刊 / 会议" value={fields.publication} disabled={lockFields} onChange={event => set('publication', event.target.value)} />{sourceHint('publication')}</label>
                <label className="field"><span>DOI</span><input aria-label="DOI" value={fields.doi} disabled={lockFields} onChange={event => set('doi', event.target.value)} />{sourceHint('doi')}</label>
                <label className="field"><span>链接</span><input aria-label="链接" value={fields.url} disabled={lockFields} onChange={event => set('url', event.target.value)} />{sourceHint('url')}</label>
              </div></details>
              {!!suggestion?.warnings.length && <div className="paper-import-warnings">{suggestion.warnings.filter(warning => /OCR|扫描件/.test(warning)).map((warning, index) => <p key={index}>{warning}</p>)}<details><summary>识别提示（{suggestion.warnings.length}）</summary>{suggestion.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details></div>}
              {suggestion?.firstPageText && <details className="paper-import-extracted"><summary>查看首页提取文字</summary><p>{suggestion.firstPageText}</p></details>}
            </>}
          </section>
          <section className="paper-import-preview" aria-label="核对 PDF 原文"><div className="paper-import-preview-heading"><h3>原文对照</h3><div><button className="quiet-icon" aria-label="上一页预览" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /></button><span>{page} / {pageCount || '…'}</span><button className="quiet-icon" aria-label="下一页预览" disabled={page >= pageCount} onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></button></div></div><PdfReader blob={selected.file} pageNumber={page} onPageCount={setPageCount} onPageChange={setPage} /></section>
        </div>}
      </div>
      <div className="modal-foot"><span className="save-hint">{saving ? '正在保存文献信息与 PDF…' : '核对确认后才会添加到文献库'}</span><button className="button ghost" disabled={saving} onClick={onClose}>取消</button><button className="button primary" disabled={saving || reading || !fields} data-save-editor onClick={() => void save()}>{saving ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}{saving ? '正在保存' : '确认保存并阅读'}</button></div>
    </div>
  </div>;
}
