import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, BookOpen, Check, ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Languages, Pause, Play, Plus, RefreshCw, Settings, X } from 'lucide-react';
import type { Entity } from '../shared/types';
import { TRANSLATION_RULES, TRANSLATION_RULE_VERSION, type TranslationConfig, type TranslationJob, type TranslationSettings, type TranslationStatus, type TranslationSummary } from '../shared/translation';
import * as api from './api';
import { PdfReader } from './PdfReader';
import './translation.css';

const statusLabels: Record<TranslationStatus, string> = { ready: '尚未翻译', running: '正在翻译', paused: '已暂停', failed: '需要重试', completed: '翻译完成' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const savedTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
function summaryOf(job: TranslationJob): TranslationSummary {
  const { blocks, ...summary } = job;
  return { ...summary, blockCount: blocks.length, completedBlocks: blocks.filter(block => Boolean(block.translation)).length };
}

/** A paper is the navigation unit; translations are local reading material for its PDF. */
export function PaperReader({ paper, readOnly, onBack, onEdit }: { paper: Entity; readOnly: boolean; onBack: () => void; onEdit: () => void }) {
  const [attachmentId, setAttachmentId] = useState(() => paper.attachments?.find(item => item.available !== false)?.id || paper.attachments?.[0]?.id || '');
  const [mode, setMode] = useState<'pdf' | 'text'>('pdf');
  const [view, setView] = useState<'source' | 'bilingual' | 'translation'>('source');
  const [fontSize, setFontSize] = useState(16);
  const [pageNumber, setPageNumber] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [translationOpen, setTranslationOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<TranslationSettings>();
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [jobs, setJobs] = useState<TranslationSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [job, setJob] = useState<TranslationJob>();
  const [loading, setLoading] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const selectedRef = useRef(selectedId), jobVersion = useRef(0), listVersion = useRef(0), settingsVersion = useRef(0);
  const context = `${paper.id}:${attachmentId}`, contextRef = useRef(context);
  selectedRef.current = selectedId; contextRef.current = context;
  const attachment = paper.attachments?.find(item => item.id === attachmentId);
  const originalUnavailable = !attachment || attachment.available === false;
  const versions = jobs.filter(item => item.paperId === paper.id && item.attachmentId === attachmentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const hasOtherRunning = jobs.some(item => item.status === 'running' && item.id !== job?.id);
  const hasRunning = jobs.some(item => item.status === 'running');

  // Reading a PDF never needs to unlock stored API credentials.
  const loadSettings = useCallback(async () => {
    const version = ++settingsVersion.current;
    setSettingsLoading(true); setAuthorized(false); setError('');
    try { const next = await api.translationSettings(); if (version === settingsVersion.current) setSettings(next); }
    catch (caught) { if (version === settingsVersion.current) setError(messageOf(caught)); }
    finally { if (version === settingsVersion.current) setSettingsLoading(false); }
  }, []);
  const loadJobs = useCallback(async () => {
    const version = ++listVersion.current;
    setLoading(true); setAuthorized(false);
    try {
      const result = await api.listTranslations();
      if (version !== listVersion.current || contextRef.current !== context) return;
      setJobs(result.jobs);
      const local = result.jobs.filter(item => item.paperId === paper.id && item.attachmentId === attachmentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setSelectedId(current => local.some(item => item.id === current) ? current : local[0]?.id || '');
      setRefreshVersion(value => value + 1);
    } catch (caught) { if (version === listVersion.current) setError(messageOf(caught)); }
    finally { if (version === listVersion.current) setLoading(false); }
  }, [paper.id, attachmentId, context]);
  useEffect(() => { void loadJobs(); return () => { ++listVersion.current; }; }, [loadJobs]);
  useEffect(() => { if (translationOpen) void loadSettings(); }, [translationOpen, loadSettings]);
  useEffect(() => () => { ++settingsVersion.current; ++jobVersion.current; }, []);
  useEffect(() => {
    if (!paper.attachments?.some(item => item.id === attachmentId)) {
      setAttachmentId(paper.attachments?.find(item => item.available !== false)?.id || paper.attachments?.[0]?.id || '');
      setJob(undefined); setSelectedId(''); setPdfPageCount(0); setPageNumber(1);
    }
  }, [paper.attachments, attachmentId]);
  useEffect(() => {
    const version = ++jobVersion.current;
    setAuthorized(false);
    setJob(current => current?.id === selectedId && current.attachmentId === attachmentId ? current : undefined);
    if (selectedId) void api.getTranslation(selectedId).then(next => {
      if (version === jobVersion.current && contextRef.current === context && next.paperId === paper.id && next.attachmentId === attachmentId) {
        setJob(next); setPageNumber(current => Math.min(current, next.pageCount));
      }
    }).catch(caught => { if (version === jobVersion.current) setError(messageOf(caught)); });
    return () => { ++jobVersion.current; };
  }, [selectedId, refreshVersion, paper.id, attachmentId, context]);
  useEffect(() => {
    if (!hasRunning) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = jobVersion.current;
      try {
        const result = await api.listTranslations();
        const next = selectedId ? await api.getTranslation(selectedId) : undefined;
        if (!disposed && version === jobVersion.current && contextRef.current === context) {
          setJobs(result.jobs);
          if (next?.paperId === paper.id && next.attachmentId === attachmentId) setJob(next);
        }
      } catch (caught) { if (!disposed) setError(messageOf(caught)); }
      if (!disposed) timer = setTimeout(() => void poll(), 1200);
    };
    timer = setTimeout(() => void poll(), 1200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [selectedId, hasRunning, context, paper.id, attachmentId]);

  const remember = (next: TranslationJob) => {
    setJobs(current => [summaryOf(next), ...current.filter(item => item.id !== next.id)]);
    if (selectedRef.current === next.id) {
      ++jobVersion.current;
      setJob(next);
    }
  };
  const prepare = async (newVersion = false) => {
    if ((!newVersion && (job || selectedId)) || originalUnavailable || readOnly || busy || loading) return;
    const expected = context;
    setBusy('prepare'); setError(''); setNotice('');
    try {
      const next = await api.createTranslation(paper.id, attachmentId);
      if (contextRef.current !== expected) return;
      remember(next); selectedRef.current = next.id; setSelectedId(next.id); setJob(next); setAuthorized(false);
      setNotice('原文已在本地提取。确认开始翻译后才会发送论文文字。');
    } catch (caught) { if (contextRef.current === expected) setError(messageOf(caught)); }
    finally { if (contextRef.current === expected) setBusy(''); }
  };
  const textMode = () => { setMode('text'); void prepare(); };
  const toggleTranslation = () => {
    if (translationOpen) { setTranslationOpen(false); return; }
    setTranslationOpen(true); setMode('text'); setView('bilingual'); void prepare();
  };
  const control = async (action: 'start' | 'pause') => {
    if (!job || readOnly || (action === 'start' && !authorized)) return;
    const expected = context;
    ++jobVersion.current; setBusy(action); setError(''); setNotice('');
    try {
      const shown = job.config || settings;
      if (action === 'start' && !shown) throw new Error('请重新载入翻译设置后再确认开始。');
      const next = action === 'start' ? await api.startTranslation(job.id, {
        baseUrl: shown!.baseUrl, model: shown!.model, glossary: shown!.glossary, instructions: shown!.instructions,
      }) : await api.pauseTranslation(job.id);
      if (contextRef.current !== expected) return;
      remember(next); setAuthorized(false);
      if (action === 'pause') setNotice('已暂停，完成的段落已保存。继续时会从未完成处开始。');
    } catch (caught) { if (contextRef.current === expected) { setAuthorized(false); setError(messageOf(caught)); } }
    finally { if (contextRef.current === expected) setBusy(''); }
  };
  const openPdf = async () => {
    if (originalUnavailable) return;
    setError('');
    if (window.academicDesktop) { try { await window.academicDesktop.openPdf(paper.id, attachmentId); } catch (caught) { setError(messageOf(caught)); } return; }
    const popup = window.open('about:blank', '_blank');
    if (!popup) { setError('浏览器阻止了 PDF 窗口，请允许弹出窗口后重试'); return; }
    popup.opener = null;
    try { const blob = await api.getPdf(paper.id, attachmentId); const url = URL.createObjectURL(blob); popup.location.href = url; window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    catch (caught) { popup.close(); setError(messageOf(caught)); }
  };
  const exportMarkdown = async () => {
    if (!job) return;
    setBusy('export'); setError('');
    try { api.saveBlob(await api.exportTranslation(job.id), `${paper.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 100) || '文献'}-双语翻译.md`); setNotice('双语 Markdown 已导出，未完成的段落保留原文。'); }
    catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(''); }
  };
  const completed = job?.blocks.filter(block => Boolean(block.translation)).length || 0;
  const progress = job?.blocks.length ? Math.round(completed / job.blocks.length * 100) : 0;
  const pageCount = (mode === 'pdf' ? pdfPageCount || job?.pageCount : job?.pageCount || pdfPageCount) || 1;
  const blocks = job?.blocks.filter(block => block.page === pageNumber) || [];
  const effectiveConfig = job?.config || settings;
  const keyMatches = Boolean(settings?.hasApiKey && !settings.keyError && effectiveConfig?.baseUrl === settings.baseUrl);
  const pending = Boolean(busy) || loading || Boolean(selectedId && !job);

  return <section className="paper-reader translation-panel" aria-label="文献阅读器">
    <header className="paper-reader-header">
      <button className="reader-back" onClick={onBack}><ArrowLeft size={16} />返回文献库</button>
      <div className="paper-reader-title"><h1>{paper.title}</h1><p>{[paper.authors, paper.year, paper.publication].filter(Boolean).join(' · ') || '文献信息待补充'}</p></div>
      <button className="button tiny" onClick={onEdit}>{readOnly ? '文献信息' : '编辑文献信息'}</button>
    </header>
    <div className="paper-reader-toolbar">
      <div className="reader-modes" aria-label="阅读模式"><button aria-pressed={mode === 'pdf'} className={mode === 'pdf' ? 'selected' : ''} onClick={() => setMode('pdf')}><FileText size={15} />原版 PDF</button><button aria-pressed={mode === 'text'} className={mode === 'text' ? 'selected' : ''} onClick={textMode} disabled={pending && !job}><BookOpen size={15} />文本阅读</button></div>
      {(paper.attachments?.length || 0) > 1 && <label className="reader-file-select"><span className="translation-sr-only">PDF 附件</span><select aria-label="PDF 附件" value={attachmentId} disabled={Boolean(busy)} onChange={event => { setAttachmentId(event.target.value); setJob(undefined); setSelectedId(''); setPageNumber(1); setPdfPageCount(0); setAuthorized(false); setError(''); setNotice(''); }}>{paper.attachments?.map(item => <option key={item.id} value={item.id}>{item.name}{item.available === false ? '（未在此设备）' : ''}</option>)}</select></label>}
      <div className="reader-tool-actions"><button className={`button tiny ${translationOpen ? 'secondary' : 'ghost'}`} aria-expanded={translationOpen} aria-controls="paper-translation-tools" onClick={toggleTranslation} disabled={pending && !job}><Languages size={15} />全文翻译{job?.status === 'running' && <span className="reader-running-dot" />}</button><button className="quiet-icon" aria-label="在外部打开 PDF" title="在外部打开 PDF" onClick={() => void openPdf()} disabled={originalUnavailable}><ExternalLink size={16} /></button></div>
    </div>
    {readOnly && <p className="translation-help">当前为只读模式，可以阅读原 PDF 和已有译文、导出资料；创建译本和翻译已停用。</p>}
    {error && <div className="translation-feedback error" role="alert"><span>{error}</span><button className="button tiny" disabled={Boolean(busy)} onClick={() => { setError(''); void loadJobs(); if (translationOpen) void loadSettings(); }}>重新载入</button></div>}
    {notice && <div className="translation-feedback" role="status"><span>{notice}</span><button className="quiet-icon" aria-label="关闭阅读提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
    <div className={`paper-reader-workspace ${translationOpen ? 'with-translation' : ''}`}>
      {translationOpen && <aside id="paper-translation-tools" className="reader-translation-tools" aria-label="当前文献翻译">
        <div className="reader-panel-heading"><h2>全文翻译</h2><button className="quiet-icon" aria-label="收起翻译工具" onClick={() => setTranslationOpen(false)}><X size={17} /></button></div>
        <p className="translation-muted">译文随这篇文献保存在本机，切换阅读方式不会重新翻译。</p>
        {job && <div className="translation-progress"><div><span className={`translation-status ${job.status}`}>{job.status === 'completed' && job.warnings.length ? '已译可提取文字' : statusLabels[job.status]}</span><strong>{progress}%</strong></div><progress aria-label="当前文献翻译进度" max={100} value={progress} /><small>{completed} / {job.blocks.length} 段已保存<br />保存于 {savedTime(job.updatedAt)}</small></div>}
        {job?.error && <div className="translation-feedback error" role="alert">{job.error} 已完成的段落仍可阅读。</div>}
        {settingsLoading && <p className="translation-muted">正在读取翻译设置…</p>}
        {settings?.keyError && <div className="translation-feedback error" role="alert"><span>{settings.keyError}</span><button className="button tiny" disabled={settingsLoading} onClick={() => void loadSettings()}>重新载入密钥</button></div>}
        {!settings?.hasApiKey && !settings?.keyError && settings && !readOnly && <p className="translation-key-hint">尚未配置 API 密钥。你仍可提取和阅读原文。</p>}
        {!job && <p className="translation-muted">{pending ? '正在准备本地阅读稿…' : readOnly ? '此 PDF 尚无本地阅读稿。只读模式可阅读原版 PDF。' : originalUnavailable ? '这篇文献没有可用的本机 PDF，请先导入附件。' : '先在本地提取文字，即可按段阅读和翻译。'}</p>}
        {!job && !readOnly && <button className="button secondary" disabled={pending || originalUnavailable} onClick={() => void prepare()}>提取原文</button>}
        {job && job.status !== 'completed' && !readOnly && <div className="translation-run">
          {job.status === 'running' ? <><p>翻译进行中，你可以收起此面板继续阅读。</p><button className="button secondary" disabled={Boolean(busy)} onClick={() => void control('pause')}><Pause size={15} />暂停翻译</button></> : <>
            {keyMatches && effectiveConfig ? <label className="translation-consent"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} /><span>同意将未译文字、术语表和翻译要求发送至 <strong>{effectiveConfig.baseUrl}</strong>，使用 <strong>{effectiveConfig.model}</strong>。调用可能计费。</span></label> : <p>{job.config && job.config.baseUrl !== settings?.baseUrl ? `此译本沿用 ${job.config.baseUrl}。请恢复该地址和密钥，或用当前设置新建译本。` : settings?.keyError ? '请先处理密钥读取问题。' : '配置 API 密钥后即可开始翻译。'}</p>}
            {job.config && <small>继续使用首次翻译的模型、术语和要求。</small>}
            <button className="button primary" disabled={Boolean(busy) || !keyMatches || !authorized || hasOtherRunning} onClick={() => void control('start')}><Play size={15} />{busy === 'start' ? '正在开始…' : job.status === 'failed' ? '重试未完成段落' : job.status === 'paused' ? '继续翻译' : '开始全文翻译'}</button>
            {hasOtherRunning && <small>另一份文献正在翻译，请等待完成或返回该文献暂停。</small>}
          </>}
        </div>}
        <button className="button ghost reader-settings-toggle" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(open => !open)}><Settings size={15} />翻译设置</button>
        {settingsOpen && (settings ? <TranslationSettingsForm settings={settings} readOnly={readOnly} onSaved={next => { setSettings(next); setAuthorized(false); }} /> : <p className="translation-muted">翻译设置暂时不可用，请重新载入。</p>)}
        {versions.length > 0 && <details className="reader-versions"><summary>此 PDF 的译本（{versions.length}）</summary><label className="field"><span>本地译本</span><select value={selectedId} onChange={event => { setSelectedId(event.target.value); setAuthorized(false); setNotice(''); }}>{versions.map(item => <option key={item.id} value={item.id}>{savedTime(item.createdAt)} · {statusLabels[item.status]} · {item.completedBlocks}/{item.blockCount} 段</option>)}</select></label>{!readOnly && <button className="button tiny" disabled={pending || originalUnavailable || hasRunning} onClick={() => void prepare(true)}><Plus size={14} />用当前设置新建译本</button>}<p>保留旧译本，新译本需要重新翻译。</p></details>}
        {job && <button className="button secondary reader-export" disabled={Boolean(busy)} onClick={() => void exportMarkdown()}><Download size={15} />导出 Markdown</button>}
      </aside>}
      <div className="paper-document">
        <div className="reader-pagebar">
          {mode === 'text' ? <div className="translation-view-toggle" aria-label="文本显示"><button className={view === 'source' ? 'selected' : ''} aria-pressed={view === 'source'} onClick={() => setView('source')}>原文</button><button className={view === 'bilingual' ? 'selected' : ''} aria-pressed={view === 'bilingual'} onClick={() => setView('bilingual')}>中英对照</button><button className={view === 'translation' ? 'selected' : ''} aria-pressed={view === 'translation'} onClick={() => setView('translation')}>仅译文</button></div> : <span className="reader-file-name">{attachment?.name || '尚未导入 PDF'}</span>}
          <div className="translation-pagination"><button className="quiet-icon" aria-label="上一页" disabled={pageNumber <= 1} onClick={() => setPageNumber(number => number - 1)}><ChevronLeft size={18} /></button><label><span className="translation-sr-only">阅读页码</span><select aria-label="阅读页码" value={Math.min(pageNumber, pageCount)} onChange={event => setPageNumber(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, index) => <option key={index + 1} value={index + 1}>第 {index + 1} 页 / {pageCount}</option>)}</select></label><button className="quiet-icon" aria-label="下一页" disabled={pageNumber >= pageCount} onClick={() => setPageNumber(number => number + 1)}><ChevronRight size={18} /></button></div>
        </div>
        {mode === 'pdf' ? originalUnavailable ? <div className="translation-empty"><FileText size={36} /><h2>{attachment ? 'PDF 未在此设备' : '还没有 PDF 附件'}</h2><p>导入论文 PDF 后，就能在这里阅读，并按需开启全文翻译。已有的本地阅读稿仍可从「文本阅读」打开。</p><button className="button secondary" onClick={onEdit}>{readOnly ? '查看文献信息' : '导入 PDF / 编辑文献信息'}</button></div> : <PdfReader paperId={paper.id} attachmentId={attachmentId} pageNumber={pageNumber} onPageCount={setPdfPageCount} onPageChange={setPageNumber} /> : <>
          {!job ? <div className="translation-empty"><BookOpen size={36} /><h2>{pending ? '正在准备本地阅读稿…' : '用适合阅读的文字布局'}</h2><p>{readOnly ? '此 PDF 尚无本地阅读稿。只读模式可阅读原版 PDF。' : originalUnavailable ? '这篇文献没有可用的本机 PDF，请先在文献信息中导入附件。' : '原文在本机提取，不需要 API 密钥。图表、公式和扫描页请切回原版 PDF 核对。'}</p>{!readOnly && <button className="button secondary" disabled={pending || originalUnavailable} onClick={() => void prepare()}>提取原文</button>}</div> : <>
            <div className="reader-text-options"><span>第 {pageNumber} 页{view === 'source' ? ' · 原文' : view === 'bilingual' ? ' · 逐段对照' : ' · 中文译文'}</span><label>字号<select aria-label="阅读字号" value={fontSize} onChange={event => setFontSize(Number(event.target.value))}>{[14, 16, 18, 20, 22].map(size => <option key={size} value={size}>{size}</option>)}</select></label></div>
            {job.warnings.length > 0 && <details className="translation-warnings"><summary>提取与检查提醒（{job.warnings.length}）</summary><ul>{job.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
            <section className={`translation-page ${view}`} aria-label={`第 ${pageNumber} 页阅读稿`} style={{ '--reading-font-size': `${fontSize}px` } as CSSProperties}>
              {blocks.length ? blocks.map((block, index) => <article className="translation-block" key={block.id} aria-label={`第 ${pageNumber} 页第 ${index + 1} 段`}>
                {view !== 'translation' && <div className="translation-source" lang="en"><p>{block.source}</p></div>}
                {view !== 'source' && <div className="translation-target" lang="zh-CN">{block.translation ? <p>{block.translation}</p> : <p className="translation-pending">这一段尚未翻译。<button className="text-link" onClick={() => { setTranslationOpen(true); if (view === 'translation') setView('bilingual'); }}>阅读原文 / 开启翻译</button></p>}{block.warnings.length > 0 && <ul className="translation-block-warnings">{block.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</div>}
              </article>) : <div className="translation-empty-page"><FileText size={25} /><p>这一页没有提取到可读文字。</p><span>可能是空白页或扫描内容。<button className="text-link" onClick={() => setMode('pdf')}>查看这一页的原版 PDF</button>，当前不支持 OCR。</span></div>}
            </section>
            <p className="translation-reading-note">{view === 'source' ? '文本阅读仅展示提取的文字，图表和公式以原版 PDF 为准。' : '机器译文辅助阅读。引用、公式和学术结论请结合原文核对。'}</p>
          </>}
        </>}
      </div>
    </div>
  </section>;
}

function TranslationSettingsForm({ settings, readOnly, onSaved }: { settings: TranslationSettings; readOnly: boolean; onSaved: (value: TranslationSettings) => void }) {
  const [glossary, setGlossary] = useState(settings.glossary.map(term => `${term.source} = ${term.target}`).join('\n'));
  const [instructions, setInstructions] = useState(settings.instructions);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const save = async () => {
    if (readOnly || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const terms = glossary.split('\n').filter(line => line.trim()).map((line, index) => {
        const separator = line.indexOf('=');
        if (separator < 1 || !line.slice(separator + 1).trim()) throw new Error(`术语表第 ${index + 1} 行请使用「英文术语 = 中文译法」格式`);
        return { source: line.slice(0, separator).trim(), target: line.slice(separator + 1).trim() };
      });
      // Rules belong here; connection details belong to the shared model settings.
      const latest = await api.translationSettings();
      const next = await api.saveTranslationSettings({ baseUrl: latest.baseUrl, model: latest.model, glossary: terms, instructions });
      onSaved(next); setInstructions(next.instructions); setGlossary(next.glossary.map(term => `${term.source} = ${term.target}`).join('\n'));
      setNotice('翻译设置已保存。');
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(false); }
  };
  return <section className="translation-settings" aria-labelledby="translation-settings-title"><h2 id="translation-settings-title">学术翻译规则</h2><p>当前模型：{settings.model}。连接地址和密钥在「资料与设置」统一管理。</p><a className="text-link" href="#settings">模型设置</a>
    <form className="translation-settings-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="field full-field"><span>术语表（每行一个：英文术语 = 中文译法）</span><textarea rows={4} value={glossary} disabled={readOnly || busy} onChange={event => setGlossary(event.target.value)} placeholder={'working memory = 工作记忆\neffect size = 效应量'} /></label>
      <label className="field full-field"><span>额外翻译要求</span><textarea rows={3} value={instructions} disabled={readOnly || busy} onChange={event => setInstructions(event.target.value)} placeholder="例如：保持心理学领域的术语习惯，缩写首次出现时保留英文。" /></label>
      <details className="translation-rules full-field"><summary>查看固定学术翻译规则</summary><ol>{TRANSLATION_RULES.map(rule => <li key={rule}>{rule}</li>)}</ol><p>规则版本：{TRANSLATION_RULE_VERSION}。这些规则帮助约束翻译，不能保证学术准确性。</p></details>
      {error && <p className="translation-feedback error full-field" role="alert">{error}</p>}{notice && <p className="translation-feedback full-field" role="status">{notice}</p>}
      <div className="translation-settings-actions full-field"><button type="submit" className="button primary" disabled={readOnly || busy}><Check size={15} />{busy ? '正在保存…' : '保存翻译设置'}</button></div>
    </form>
  </section>;
}
