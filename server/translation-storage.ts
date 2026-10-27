import * as fs from 'node:fs/promises';
import { AppError, hash, listFiles, readSafe, safePath } from './fs-safe';
import { isUuid } from './entities';
import type { Workspace } from './workspace';
import type { Entity } from '../src/shared/types';
import type { TranslationJob } from '../src/shared/translation';

const MAX_JOB_BYTES = 32 * 1024 * 1024;
const JOB_KEYS = ['schemaVersion', 'id', 'paperId', 'attachmentId', 'paperTitle', 'sourceName', 'sourceHash', 'createdAt', 'updatedAt', 'status', 'pageCount', 'blocks', 'warnings', 'error', 'config', 'ruleVersion'];
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function invalid(detail: string): never { throw new AppError(`翻译资料格式无效：${detail}`, 400, 'TRANSLATION_INVALID'); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid('包含不支持的字段');
}
function text(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim().length > 0);
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function warnings(value: unknown): boolean { return Array.isArray(value) && value.length <= 5000 && value.every(item => text(item, 4096)); }
function validBaseUrl(value: unknown): boolean {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}

/** Exact fields also keep accidental API keys out of authoritative files and backups. */
export function validateTranslationJob(value: unknown, relative?: string): asserts value is TranslationJob {
  object(value, JOB_KEYS);
  if (value.schemaVersion !== 1) invalid('翻译版本不受支持');
  if (![value.id, value.paperId, value.attachmentId].every(isUuid)) invalid('身份无效');
  if (relative !== undefined && relative !== `papers/${value.paperId}/translations/${value.id}.json`) invalid('身份与路径不一致');
  if (!text(value.paperTitle, 500) || !text(value.sourceName, 1000) || !text(value.ruleVersion, 100) || typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceHash)) invalid('来源字段无效');
  if (!timestamp(value.createdAt) || !timestamp(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.createdAt)) invalid('时间无效');
  if (!['ready', 'running', 'paused', 'failed', 'completed'].includes(String(value.status)) || !Number.isSafeInteger(value.pageCount) || (value.pageCount as number) < 1 || (value.pageCount as number) > 10000) invalid('状态或页数无效');
  if (!warnings(value.warnings) || (value.error !== undefined && !text(value.error, 4096))) invalid('提示信息无效');
  if (!Array.isArray(value.blocks) || value.blocks.length > 20000) invalid('段落数量无效');
  const ids = new Set<string>();
  for (const block of value.blocks) {
    object(block, ['id', 'page', 'source', 'translation', 'warnings']);
    if (!text(block.id, 128) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(block.id) || ids.has(block.id)) invalid('段落身份无效或重复');
    ids.add(block.id);
    if (!Number.isSafeInteger(block.page) || (block.page as number) < 1 || (block.page as number) > (value.pageCount as number) || !text(block.source, 100000)) invalid('段落页码或原文无效');
    if ((block.translation !== undefined && !text(block.translation, 200000)) || !warnings(block.warnings)) invalid('译文或提示无效');
  }
  if (value.status === 'completed' && (!value.blocks.length || value.blocks.some(block => !text(block.translation, 200000)))) invalid('尚有段落没有译文');
  if (value.config !== undefined) {
    object(value.config, ['baseUrl', 'model', 'glossary', 'instructions']);
    if (!validBaseUrl(value.config.baseUrl) || !text(value.config.model, 200) || !text(value.config.instructions, 20000, true) || !Array.isArray(value.config.glossary) || value.config.glossary.length > 1000) invalid('模型配置无效');
    for (const term of value.config.glossary) {
      object(term, ['source', 'target']);
      if (!text(term.source, 2000) || !text(term.target, 2000)) invalid('术语表无效');
    }
  }
}

export function parseTranslationJob(bytes: Uint8Array, relative: string): TranslationJob {
  if (bytes.byteLength > MAX_JOB_BYTES) invalid('文件超过 32 MB');
  let value: unknown;
  try { value = JSON.parse(textDecoder.decode(bytes)); } catch { invalid('无法读取 JSON'); }
  validateTranslationJob(value, relative); return value;
}

async function readJobFile(workspace: Workspace, relative: string): Promise<TranslationJob> {
  const file = await safePath(workspace.root, relative), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_JOB_BYTES) invalid('文件类型或大小无效');
  return parseTranslationJob(await readSafe(workspace.root, relative), relative);
}
function assertSourceMetadata(job: TranslationJob, paper: Entity | undefined) {
  if (!paper || paper.type !== 'paper' || paper.id !== job.paperId) invalid('存在孤立翻译，来源文献不存在');
  const attachment = paper.attachments?.find(item => item.id === job.attachmentId);
  if (!attachment || attachment.sha256 !== job.sourceHash) invalid('来源附件身份或哈希不一致');
}
async function verifySource(workspace: Workspace, job: TranslationJob) {
  const paper = await workspace.get(job.paperId); assertSourceMetadata(job, paper);
  if (hash((await workspace.readAttachment(job.paperId, job.attachmentId)).bytes) !== job.sourceHash) invalid('来源 PDF 校验失败');
}

async function verifyDeletedSource(workspace: Workspace, job: TranslationJob) {
  let tombstone: unknown;
  try { tombstone = JSON.parse((await readSafe(workspace.root, `tombstones/paper/${job.paperId}.json`)).toString()); }
  catch { invalid('存在孤立翻译，缺少来源文献或有效删除记录'); }
  const value = tombstone as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || value.entityType !== 'paper' || value.entityId !== job.paperId || value.originalRelativePath !== `papers/${job.paperId}/metadata.json` || !timestamp(value.deletedAt) || typeof value.contentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(value.contentHash)) invalid('来源文献删除记录无效');
  // Text synchronization removes metadata only. Local PDF/translation files are
  // retained as history; only a matching paper tombstone can explain that state.
  const relative = `papers/${job.paperId}/attachments/${job.attachmentId}.pdf`;
  const stat = await fs.lstat(await safePath(workspace.root, relative));
  if (!stat.isFile() || stat.nlink > 1 || stat.size > 50 * 1024 * 1024) invalid('历史来源附件无效');
  const bytes = await readSafe(workspace.root, relative);
  if (hash(bytes) !== job.sourceHash || bytes.subarray(0, 5).toString() !== '%PDF-') invalid('历史来源 PDF 哈希校验失败');
}

export async function listTranslationJobs(workspace: Workspace): Promise<TranslationJob[]> {
  const jobs: TranslationJob[] = [], seen = new Set<string>();
  for (const paper of (await workspace.list()).filter(entity => entity.type === 'paper')) {
    for (const relative of await listFiles(workspace.root, `papers/${paper.id}/translations`)) {
      const job = await readJobFile(workspace, relative); assertSourceMetadata(job, paper);
      if (seen.has(job.id)) invalid('翻译任务身份重复');
      seen.add(job.id); jobs.push(job);
    }
  }
  return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export async function readTranslationJob(workspace: Workspace, id: string): Promise<TranslationJob> {
  if (!isUuid(id)) invalid('任务身份无效');
  const job = (await listTranslationJobs(workspace)).find(item => item.id === id);
  if (!job) throw new AppError('翻译任务不存在或来源文献已删除', 404, 'TRANSLATION_NOT_FOUND');
  return job;
}

/** Owns its exclusive section; callers must not wrap this function in exclusive(). */
export async function saveTranslationJob(workspace: Workspace, job: TranslationJob): Promise<void> {
  validateTranslationJob(job);
  const relative = `papers/${job.paperId}/translations/${job.id}.json`;
  const content = JSON.stringify(job, null, 2) + '\n';
  if (Buffer.byteLength(content) > MAX_JOB_BYTES) invalid('文件超过 32 MB');
  // Freeze the caller's object before awaiting the queue or a later mutation could
  // make the validated source identity differ from the bytes committed below.
  const saved = parseTranslationJob(Buffer.from(content), relative);
  await workspace.exclusive(async () => {
    await verifySource(workspace, saved);
    for (const existing of await listTranslationJobs(workspace)) {
      if (existing.id !== saved.id) continue;
      if (existing.paperId !== saved.paperId || existing.attachmentId !== saved.attachmentId || existing.sourceHash !== saved.sourceHash || existing.createdAt !== saved.createdAt || existing.pageCount !== saved.pageCount || existing.ruleVersion !== saved.ruleVersion || JSON.stringify(existing.blocks.map(({ id, page, source }) => ({ id, page, source }))) !== JSON.stringify(saved.blocks.map(({ id, page, source }) => ({ id, page, source })))) invalid('任务来源和原文不能覆盖，请创建新任务');
    }
    await workspace.prepareTranslationStorage();
    // Recheck after the potentially slow pre-upgrade backup before committing.
    await verifySource(workspace, saved);
    await workspace.writeManagedFile(relative, content);
  });
}

/** Restore uses the complete tree so orphan files cannot hide behind an absent paper. */
export async function validateWorkspaceTranslations(workspace: Workspace): Promise<void> {
  const papers = new Map((await workspace.list()).filter(item => item.type === 'paper').map(item => [item.id, item]));
  const seen = new Set<string>();
  for (const relative of await listFiles(workspace.root, 'papers')) {
    if (!relative.split('/').includes('translations')) continue;
    const job = await readJobFile(workspace, relative);
    if (seen.has(job.id)) invalid('翻译任务身份重复');
    seen.add(job.id);
    if (papers.has(job.paperId)) {
      assertSourceMetadata(job, papers.get(job.paperId)); await verifySource(workspace, job);
    } else await verifyDeletedSource(workspace, job);
  }
  if (seen.size) {
    const metadata = JSON.parse((await readSafe(workspace.root, 'workspace.json')).toString());
    if (metadata.schemaVersion !== 2) invalid('翻译资料需要版本 2 工作区');
  }
}
