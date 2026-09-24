import { randomUUID } from 'node:crypto';
import type { Entity, EntityInput, EntityType } from '../src/shared/types';
import { AppError } from './fs-safe';
export const TYPES: EntityType[] = ['task', 'event', 'paper', 'note', 'log'];
export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function dateOnly(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
function dateTime(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)); }
function invalid(file: string, detail = '无法读取资料格式'): never { throw new AppError(`${detail}：${file}`); }
export function entityPath(e: Entity) {
  if (e.type === 'paper') return `papers/${e.id}/metadata.json`;
  if (e.type === 'log') return `logs/${e.date!.slice(0, 4)}/${e.id}.md`;
  return `${e.type === 'note' ? 'notes' : e.type === 'task' ? 'tasks' : 'events'}/${e.id}.${e.type === 'note' ? 'md' : 'json'}`;
}
export function serializeEntity(entity: Entity): string {
  if (entity.type !== 'note' && entity.type !== 'log') return JSON.stringify(entity, null, 2) + '\n';
  const { body = '', ...metadata } = entity; return `---\n${JSON.stringify(metadata, null, 2)}\n---\n${body}`;
}
function validateEntityFields(parsed: unknown, file: string): asserts parsed is Entity {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid(file);
  const entity = parsed as Record<string, unknown>;
  if (!isUuid(entity.id) || !TYPES.includes(entity.type as EntityType) || entity.schemaVersion !== 1 || typeof entity.title !== 'string' || !entity.title.trim()) invalid(file);
  if (!dateTime(entity.createdAt) || !dateTime(entity.updatedAt) || !Number.isInteger(entity.revision) || (entity.revision as number) < 1) invalid(file, '资料核心字段无效');
  if (entity.body !== undefined && typeof entity.body !== 'string') invalid(file, '正文格式无效');
  if ((entity.type === 'note' || entity.type === 'log') && (!Array.isArray(entity.paperIds) || entity.paperIds.some(id => !isUuid(id)))) invalid(file, '关联文献字段无效');
  if (entity.type === 'log' && !dateOnly(entity.date)) invalid(file, '日志日期无效');
  if (entity.type === 'task') {
    if (typeof entity.completed !== 'boolean' || !['low', 'normal', 'high'].includes(entity.priority as string) || (entity.dueDate !== undefined && entity.dueDate !== '' && !dateOnly(entity.dueDate))) invalid(file, '待办字段无效');
  }
  if (entity.type === 'event') {
    if (entity.allDay !== undefined && typeof entity.allDay !== 'boolean') invalid(file, '日程全天标记无效');
    if (entity.date !== undefined && !dateOnly(entity.date)) invalid(file, '日程日期无效');
    const valid = entity.allDay === true ? dateOnly : (value: unknown) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
    if (!valid(entity.start) || !valid(entity.end) || Date.parse(entity.end as string) < Date.parse(entity.start as string)) invalid(file, '日程时间无效');
  }
  if (entity.type === 'paper') {
    if (typeof entity.authors !== 'string' || !Array.isArray(entity.tags) || entity.tags.some(tag => typeof tag !== 'string') || !['unread', 'reading', 'read'].includes(entity.readingStatus as string)) invalid(file, '文献字段无效');
    if (entity.year !== undefined && (!Number.isInteger(entity.year) || (entity.year as number) < 1 || (entity.year as number) > 9999)) invalid(file, '文献年份无效');
    if (entity.url !== undefined && entity.url !== '' && (typeof entity.url !== 'string' || !/^https?:\/\//i.test(entity.url))) invalid(file, '文献链接无效');
    if (entity.attachments !== undefined && (!Array.isArray(entity.attachments) || entity.attachments.some(attachment => {
      if (!attachment || typeof attachment !== 'object') return true;
      const value = attachment as Record<string, unknown>;
      return !isUuid(value.id) || value.path !== `papers/${entity.id}/attachments/${value.id}.pdf` || typeof value.name !== 'string' || !value.name || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256) || !Number.isInteger(value.size) || (value.size as number) < 0 || (value.available !== undefined && typeof value.available !== 'boolean');
    }))) invalid(file, '文献附件字段无效');
  }
}
export function parseEntity(text: string, file: string): Entity {
  let parsed: Entity;
  try {
    if (file.endsWith('.md')) {
      if (!text.startsWith('---\n')) throw new AppError(`笔记缺少前置元数据：${file}`);
      const end = text.indexOf('\n---\n', 4); if (end === -1) throw new AppError(`笔记元数据不完整：${file}`);
      parsed = { ...JSON.parse(text.slice(4, end)), body: text.slice(end + 5) };
    } else parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid(file);
  }
  validateEntityFields(parsed, file);
  if (entityPath(parsed) !== file) throw new AppError(`资料身份与路径不一致：${file}`);
  return parsed;
}
export function normalizeEntity(input: EntityInput, previous?: Entity): Entity {
  if (!input || !TYPES.includes(input.type) || typeof input.title !== 'string' || !input.title.trim()) throw new AppError('请填写标题和有效资料类型');
  if (input.title.length > 500 || (typeof input.body === 'string' && input.body.length > 2_000_000)) throw new AppError('内容超过允许长度');
  if (previous && previous.type !== input.type) throw new AppError('资料类型不能改变');
  const now = new Date().toISOString();
  const entity = { ...previous, ...input, id: previous?.id ?? randomUUID(), type: input.type, title: input.title.trim(), schemaVersion: 1, createdAt: previous?.createdAt ?? now, updatedAt: now, revision: (previous?.revision ?? 0) + 1 } as Entity;
  delete entity.expectedRevision;
  if (entity.body !== undefined && typeof entity.body !== 'string') throw new AppError('正文必须为文本');
  if (['note', 'log'].includes(entity.type)) {
    entity.body ??= ''; entity.paperIds ??= [];
    if (!Array.isArray(entity.paperIds) || entity.paperIds.some(id => !isUuid(id))) throw new AppError('关联文献无效');
    entity.paperIds = [...new Set(entity.paperIds)];
  }
  if (entity.type === 'log' && !dateOnly(entity.date)) throw new AppError('请填写有效日志日期');
  if (entity.type === 'task') {
    entity.completed ??= false; entity.priority ??= 'normal';
    if (typeof entity.completed !== 'boolean' || !['low', 'normal', 'high'].includes(entity.priority)) throw new AppError('待办状态或优先级无效');
    if (entity.dueDate && !dateOnly(entity.dueDate)) throw new AppError('截止日期无效');
    if (entity.dueDate === '') delete entity.dueDate;
  }
  if (entity.type === 'event') {
    const valid = (v: unknown) => entity.allDay ? dateOnly(v) : typeof v === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
    if (!valid(entity.start) || !valid(entity.end) || Date.parse(entity.end!) < Date.parse(entity.start!)) throw new AppError('日程结束时间不能早于开始时间，且需有效日期/时区');
  }
  if (entity.type === 'paper') {
    entity.attachments = previous?.attachments ?? []; entity.tags ??= []; entity.authors ??= ''; entity.readingStatus ??= 'unread';
    if (!Array.isArray(entity.tags) || entity.tags.some(t => typeof t !== 'string') || typeof entity.authors !== 'string') throw new AppError('作者或标签格式无效');
    if (entity.year !== undefined && (!Number.isInteger(entity.year) || entity.year < 1 || entity.year > 9999)) throw new AppError('年份无效');
    if (!['unread', 'reading', 'read'].includes(entity.readingStatus)) throw new AppError('阅读状态无效');
    if (entity.url && (typeof entity.url !== 'string' || !/^https?:\/\//i.test(entity.url))) throw new AppError('文献链接需为 http 或 https');
    if (entity.url === '') delete entity.url;
  }
  validateEntityFields(entity, '新资料');
  return entity;
}
export const searchable = (e: Entity) => [e.title, e.body, e.authors, e.tags?.join(' '), e.date, e.description, e.publication].filter(Boolean).join('\n').normalize('NFC').toLocaleLowerCase();
