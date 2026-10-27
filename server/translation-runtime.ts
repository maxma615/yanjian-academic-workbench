import { randomUUID } from 'node:crypto';
import { identifyPaperMetadata } from './model-metadata';
import type { PaperMetadataSuggestion } from '../src/shared/paper-import';
import type { Workspace } from './workspace';
import { AppError, exists, readSafe, safePath } from './fs-safe';
import { extractPdf, translateBlocks, testConnection, validateTranslationConfig } from './translation-engine';
import { listTranslationJobs, readTranslationJob, saveTranslationJob } from './translation-storage';
import { TRANSLATION_RULE_VERSION } from '../src/shared/translation';
import type { TranslationConfig, TranslationJob, TranslationSettings, TranslationSummary } from '../src/shared/translation';

export interface TranslationRuntimeOptions {
  credentials?: { get(): Promise<string | null>; set(value: string): Promise<void>; delete(): Promise<void> };
  credentialsAvailable?: () => boolean;
  extract?: typeof extractPdf;
  translate?: typeof translateBlocks;
  test?: typeof testConnection;
  identify?: typeof identifyPaperMetadata;
}
const DEFAULT_CONFIG: TranslationConfig = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', glossary: [], instructions: '' };
const SETTINGS_PATH = 'state/translation-settings.json';
const KEY_READ_ERROR = '无法读取已保存的 API 密钥。请解锁系统安全存储后重新载入，或清除密钥后重新填写。';
type Active = { workspace: Workspace; id: string; paperId: string; controller: AbortController; done: Promise<void> };

/** Network calls never hold the workspace writer queue. Each response is committed separately. */
export class TranslationRuntime {
  private active?: Active;
  private memoryKey: string | null = null;
  private readonly credentials: NonNullable<TranslationRuntimeOptions['credentials']>;
  constructor(private readonly options: TranslationRuntimeOptions = {}) {
    this.credentials = options.credentials ?? {
      get: async () => this.memoryKey,
      set: async value => { this.memoryKey = value; },
      delete: async () => { this.memoryKey = null; },
    };
  }
  private async config(workspace: Workspace): Promise<TranslationConfig> {
    if (!await exists(await safePath(workspace.root, SETTINGS_PATH))) return { ...DEFAULT_CONFIG, glossary: [] };
    try { return validateTranslationConfig(JSON.parse((await readSafe(workspace.root, SETTINGS_PATH)).toString())); }
    catch { throw new AppError('翻译设置无法读取，请重新保存接口设置'); }
  }
  private async key(baseUrl: string): Promise<string | null> {
    try {
      // The secure store checks file existence before touching OS cryptography.
      // Merely opening a new workspace must not trigger a Keychain unlock prompt.
      const encrypted = await this.credentials.get();
      if (!encrypted) return null;
      if (this.options.credentialsAvailable?.() === false) throw new AppError(KEY_READ_ERROR);
      const record = JSON.parse(encrypted);
      if (typeof record?.baseUrl !== 'string' || typeof record?.key !== 'string' || !record.key) throw new AppError(KEY_READ_ERROR);
      return record.baseUrl === baseUrl ? record.key : null;
    } catch { throw new AppError(KEY_READ_ERROR); }
  }
  async settings(workspace: Workspace): Promise<TranslationSettings> {
    const config = await this.config(workspace);
    let hasApiKey = false, keyError: string | undefined;
    try { hasApiKey = Boolean(await this.key(config.baseUrl)); }
    catch { keyError = KEY_READ_ERROR; }
    return { ...config, hasApiKey, keyError, keyStorage: this.options.credentials ? 'encrypted' : 'session' };
  }
  async saveSettings(workspace: Workspace, input: unknown): Promise<TranslationSettings> {
    workspace.assertWritable();
    if (!input || typeof input !== 'object') throw new AppError('翻译设置格式无效');
    const value = input as Record<string, unknown>, config = validateTranslationConfig(input);
    if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 4096 || /[\r\n\u0000]/.test(value.apiKey))) throw new AppError('API 密钥格式无效');
    if (value.clearApiKey !== undefined && typeof value.clearApiKey !== 'boolean') throw new AppError('清除密钥选项无效');
    await workspace.exclusive(async () => {
      const old = await this.config(workspace);
      if (value.clearApiKey || old.baseUrl !== config.baseUrl) await this.credentials.delete();
      const key = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
      if (key && !value.clearApiKey) {
        if (this.options.credentialsAvailable?.() === false) throw new AppError('系统安全存储不可用，无法保存 API 密钥');
        await this.credentials.set(JSON.stringify({ baseUrl: config.baseUrl, key }));
      }
      await workspace.syncWriteAtomically(SETTINGS_PATH, JSON.stringify(config, null, 2));
    });
    return this.settings(workspace);
  }
  async test(workspace: Workspace): Promise<void> {
    workspace.assertWritable();
    const config = await this.config(workspace), key = await this.requireKey(config.baseUrl);
    try { await (this.options.test ?? testConnection)(config, key, AbortSignal.timeout(30_000)); }
    catch (error) { throw this.safeError(error); }
  }
  async inspectMetadata(workspace: Workspace, local: PaperMetadataSuggestion, expectedConfig?: unknown, signal: AbortSignal = new AbortController().signal): Promise<PaperMetadataSuggestion> {
    signal.throwIfAborted();
    const fallback = (warning: string): PaperMetadataSuggestion => ({ ...local, fields: { ...local.fields }, sources: { ...local.sources }, warnings: [...new Set([...local.warnings, warning])] });
    if (expectedConfig === undefined) return fallback('本次仅使用本地识别；配置模型后可在导入时使用在线识别。');
    workspace.assertWritable();
    const config = await this.config(workspace);
    let confirmed: TranslationConfig;
    try { confirmed = validateTranslationConfig(expectedConfig); }
    catch { throw new AppError('请重新打开导入窗口，确认当前模型设置后再识别', 409, 'TRANSLATION_CONFIG_CHANGED'); }
    if (JSON.stringify(confirmed) !== JSON.stringify(config)) throw new AppError('模型设置已被其他窗口修改，请重新打开导入窗口以确认发送目的地与模型', 409, 'TRANSLATION_CONFIG_CHANGED');
    try {
      const key = await this.key(config.baseUrl);
      signal.throwIfAborted();
      if (!key) return fallback('尚未填写此模型地址的 API 密钥，已使用本地识别；可在资料与设置中配置。');
      const result = await (this.options.identify ?? identifyPaperMetadata)(config, key, local, signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      return fallback('在线识别未完成，已保留本地候选。请核对信息，或检查模型设置后重试。');
    }
  }
  private async requireKey(baseUrl: string) {
    const key = await this.key(baseUrl);
    if (!key) throw new AppError('请先为此 API 地址填写密钥；浏览器预览重启后需重新填写');
    return key;
  }
  private safeError(error: unknown): AppError {
    return error instanceof AppError ? error : new AppError('翻译请求未完成，请检查接口地址、网络和模型设置后继续；已完成译文保留');
  }
  private visible(workspace: Workspace, job: TranslationJob): TranslationJob {
    return job.status === 'running' && !(this.active?.workspace === workspace && this.active.id === job.id)
      ? { ...job, status: 'paused', error: '上次翻译已中断，已保存的译文保留。点击继续后才会调用模型。' }
      : job;
  }
  async read(workspace: Workspace, id: string): Promise<TranslationJob> { return this.visible(workspace, await readTranslationJob(workspace, id)); }
  async list(workspace: Workspace): Promise<TranslationSummary[]> {
    return (await listTranslationJobs(workspace)).map(raw => {
      const { blocks, ...job } = this.visible(workspace, raw);
      return { ...job, blockCount: blocks.length, completedBlocks: blocks.filter(block => block.translation !== undefined).length };
    });
  }
  async create(workspace: Workspace, input: unknown): Promise<TranslationJob> {
    workspace.assertWritable();
    const value = input as { paperId?: unknown; attachmentId?: unknown };
    if (!value || typeof value.paperId !== 'string' || typeof value.attachmentId !== 'string') throw new AppError('请选择文献及本机 PDF');
    const paper = await workspace.get(value.paperId);
    if (paper.type !== 'paper') throw new AppError('请选择文献');
    const attachment = paper.attachments?.find(a => a.id === value.attachmentId);
    if (!attachment) throw new AppError('文献附件不存在');
    const file = await workspace.readAttachment(paper.id, attachment.id);
    const source = await (this.options.extract ?? extractPdf)(file.bytes);
    if (!source.blocks.length) throw new AppError('未提取到可翻译文字；扫描 PDF 需要先进行 OCR');
    const now = new Date().toISOString();
    const job: TranslationJob = {
      schemaVersion: 1, id: randomUUID(), paperId: paper.id, attachmentId: attachment.id,
      paperTitle: paper.title, sourceName: attachment.name, sourceHash: attachment.sha256,
      createdAt: now, updatedAt: now, status: 'ready', pageCount: source.pageCount,
      blocks: source.blocks, warnings: source.warnings, ruleVersion: TRANSLATION_RULE_VERSION,
    };
    await saveTranslationJob(workspace, job);
    return job;
  }
  async start(workspace: Workspace, id: string, authorized: unknown, expectedConfig?: unknown): Promise<TranslationJob> {
    workspace.assertWritable();
    if (authorized !== true) throw new AppError('请主动确认将论文文字发送到已配置的模型 API');
    if (this.active) throw new AppError('已有翻译正在进行，请先暂停或等待完成', 409);
    const job = await this.read(workspace, id);
    if (job.status === 'completed') return job;
    if (job.ruleVersion !== TRANSLATION_RULE_VERSION) throw new AppError('此译本使用另一版本规则，请新建译本以继续翻译');
    // A resumed document keeps its original model, glossary and instructions.
    const config = job.config ?? await this.config(workspace);
    let confirmed: TranslationConfig;
    try { confirmed = validateTranslationConfig(expectedConfig); }
    catch { throw new AppError('请刷新并确认当前翻译设置后再开始', 409, 'TRANSLATION_CONFIG_CHANGED'); }
    if (JSON.stringify(confirmed) !== JSON.stringify(validateTranslationConfig(config))) throw new AppError('翻译设置已被其他窗口修改，请刷新后重新确认发送目的地与模型', 409, 'TRANSLATION_CONFIG_CHANGED');
    job.config = config;
    const key = await this.requireKey(job.config.baseUrl);
    job.status = 'running'; delete job.error; job.updatedAt = new Date().toISOString();
    await saveTranslationJob(workspace, job);
    const controller = new AbortController();
    const done = Promise.resolve().then(() => this.execute(workspace, job, key, controller.signal));
    this.active = { workspace, id, paperId: job.paperId, controller, done };
    void done.finally(() => { if (this.active?.done === done) this.active = undefined; });
    return job;
  }
  private async execute(workspace: Workspace, job: TranslationJob, key: string, signal: AbortSignal): Promise<void> {
    try {
      while (job.blocks.some(b => b.translation === undefined)) {
        signal.throwIfAborted();
        // Verify the paper still exists (including after an optional GitHub deletion).
        await workspace.get(job.paperId);
        const batch = [] as TranslationJob['blocks']; let size = 0;
        for (const block of job.blocks.filter(b => b.translation === undefined)) {
          if (batch.length >= 100 || (batch.length && size + block.source.length > 6000)) break;
          batch.push(block); size += block.source.length;
        }
        const result = await (this.options.translate ?? translateBlocks)(job.config!, key, batch, { paperTitle: job.paperTitle }, signal);
        signal.throwIfAborted();
        if (result.length !== batch.length || new Set(result.map(b => b.id)).size !== batch.length || result.some(b => !batch.some(source => source.id === b.id) || !b.translation?.trim())) throw new AppError('模型返回的段落不完整，已停止；可以继续重试未完成段落');
        job = { ...job, blocks: job.blocks.map(block => {
          const translated = result.find(b => b.id === block.id);
          return translated ? { ...block, translation: translated.translation, warnings: [...new Set([...block.warnings, ...translated.warnings])] } : block;
        }), updatedAt: new Date().toISOString() };
        if (job.blocks.every(b => b.translation !== undefined)) job.status = 'completed';
        await saveTranslationJob(workspace, job);
      }
    } catch (error) {
      const updated: TranslationJob = { ...job, status: signal.aborted ? 'paused' : 'failed', updatedAt: new Date().toISOString() };
      if (signal.aborted) delete updated.error; else updated.error = this.safeError(error).message;
      // If the paper was deleted or its lock lost, never recreate its folder.
      try { await saveTranslationJob(workspace, updated); } catch { /* Original committed results remain authoritative. */ }
    }
  }
  async pause(workspace: Workspace, id: string): Promise<TranslationJob> {
    workspace.assertWritable();
    if (this.active?.workspace === workspace && this.active.id === id) { this.active.controller.abort(); await this.active.done; }
    const job = await this.read(workspace, id);
    if (job.status !== 'completed') { job.status = 'paused'; job.updatedAt = new Date().toISOString(); delete job.error; await saveTranslationJob(workspace, job); }
    return job;
  }
  async stopForPaper(workspace: Workspace, paperId: string): Promise<void> {
    if (this.active?.workspace === workspace && this.active.paperId === paperId) await this.stop();
  }
  async stop(): Promise<void> {
    const active = this.active;
    if (active) { active.controller.abort(); await active.done; if (this.active === active) this.active = undefined; }
  }
  async waitForIdle(): Promise<void> { await this.active?.done; }
  async export(workspace: Workspace, id: string): Promise<string> {
    const job = await this.read(workspace, id);
    const lines = [`# ${job.paperTitle}`, '', `来源：${job.sourceName}`, `翻译规则：${job.ruleVersion}`, `模型：${job.config?.model ?? '尚未开始'}`, `进度：${job.blocks.filter(b => b.translation !== undefined).length}/${job.blocks.length} 段`, '', '> 机器译文供辅助阅读，请对照原文核实。PDF 图像、复杂表格与公式以原文件为准。', ''];
    for (const warning of job.warnings) lines.push(`> ${warning}`);
    let page = 0;
    for (const block of job.blocks) {
      if (block.page !== page) { page = block.page; lines.push('', `## 第 ${page} 页`, ''); }
      lines.push('### 原文', '', block.source, '', '### 中文', '', block.translation ?? '（尚未翻译）', '');
      for (const warning of block.warnings) lines.push(`> 待复核：${warning}`);
    }
    return lines.join('\n');
  }
}
