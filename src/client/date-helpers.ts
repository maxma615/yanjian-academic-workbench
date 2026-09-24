import type { Entity } from '../shared/types';

export const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

function parts(value: Date | string): Record<string, string> {
  const date = typeof value === 'string' ? new Date(value) : value;
  const entries = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(part => part.type !== 'literal');
  return Object.fromEntries(entries.map(entry => [entry.type, entry.value]));
}

export function dateInShanghai(value: Date | string): string {
  const result = parts(value);
  return `${result.year}-${result.month}-${result.day}`;
}

export function timeInShanghai(value: Date | string): string {
  const result = parts(value);
  return `${result.hour}:${result.minute}`;
}

export function todayInShanghai(now: Date = new Date()): string { return dateInShanghai(now); }

export function dateLabel(value?: string): string {
  if (!value) return '未设日期';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00+08:00`) : new Date(value);
  return new Intl.DateTimeFormat('zh-CN', { timeZone: SHANGHAI_TIME_ZONE, month: 'short', day: 'numeric' }).format(date);
}

export function toShanghaiIso(date: string, time: string): string {
  return `${date}T${time || '00:00'}:00+08:00`;
}

export function parseEventForm(entity?: Entity): { startDate: string; endDate: string; startTime: string; endTime: string; allDay: boolean } {
  const allDay = entity?.allDay ?? true;
  const start = entity?.start || entity?.date || todayInShanghai();
  const end = entity?.end || start;
  if (allDay) return { startDate: start.slice(0, 10), endDate: end.slice(0, 10), startTime: '', endTime: '' , allDay: true };
  return { startDate: dateInShanghai(start), endDate: dateInShanghai(end), startTime: timeInShanghai(start), endTime: timeInShanghai(end), allDay: false };
}

export function eventFormToFields(form: { startDate: string; endDate: string; startTime: string; endTime: string; allDay: boolean }): Pick<Entity, 'date' | 'start' | 'end' | 'allDay'> {
  if (form.allDay) return { date: form.startDate, start: form.startDate, end: form.endDate || form.startDate, allDay: true };
  return { date: form.startDate, start: toShanghaiIso(form.startDate, form.startTime), end: toShanghaiIso(form.endDate || form.startDate, form.endTime || form.startTime), allDay: false };
}

function dateOnly(value?: string): string | undefined { return value ? value.slice(0, 10) : undefined; }

export function eventDateRange(entity: Entity): { start: string; end: string } | null {
  if (entity.type !== 'event') return null;
  const start = entity.start || entity.date;
  const end = entity.end || start;
  if (!start || !end) return null;
  if (entity.allDay) return { start: dateOnly(start)!, end: dateOnly(end)! };
  return { start: dateInShanghai(start), end: dateInShanghai(end) };
}

export function eventOccursOnDate(entity: Entity, date: string): boolean {
  const range = eventDateRange(entity);
  return Boolean(range && range.start <= date && date <= range.end);
}

export function eventSortValue(entity: Entity): string {
  const range = eventDateRange(entity);
  return range?.start || '9999-12-31';
}
