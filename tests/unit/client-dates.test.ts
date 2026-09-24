import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/shared/types';
import { dateInShanghai, dateLabel, eventDateRange, eventFormToFields, eventOccursOnDate, parseEventForm, timeInShanghai, todayInShanghai } from '../../src/client/date-helpers';

const event = (fields: Partial<Entity>): Entity => ({ id: 'e', type: 'event', schemaVersion: 1, title: '测试', createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z', revision: 1, ...fields });

describe('Asia/Shanghai date helpers', () => {
  it('uses Shanghai calendar date even when the device is in another timezone', () => {
    expect(dateInShanghai('2026-09-23T16:30:00Z')).toBe('2026-09-24');
    expect(timeInShanghai('2026-09-23T16:30:00Z')).toBe('00:30');
    expect(todayInShanghai(new Date('2026-09-23T16:30:00Z'))).toBe('2026-09-24');
  });

  it('keeps date-only values as calendar dates while converting timestamps in Shanghai', () => {
    expect(dateLabel('2026-09-23')).toMatch(/23/);
    expect(dateLabel('2026-09-22T16:30:00Z')).toMatch(/23/);
  });

  it('round trips timed event fields with an explicit +08:00 offset', () => {
    const fields = eventFormToFields({ startDate: '2026-09-24', endDate: '2026-09-25', startTime: '09:10', endTime: '17:45', allDay: false });
    expect(fields.start).toBe('2026-09-24T09:10:00+08:00');
    expect(fields.end).toBe('2026-09-25T17:45:00+08:00');
    expect(parseEventForm(event({ ...fields, allDay: false }))).toEqual({ startDate: '2026-09-24', endDate: '2026-09-25', startTime: '09:10', endTime: '17:45', allDay: false });
  });

  it('covers every date in an all day or timed multi-day event', () => {
    const allDay = event({ allDay: true, start: '2026-09-24', end: '2026-09-26' });
    const timed = event({ allDay: false, start: '2026-09-24T23:00:00+08:00', end: '2026-09-26T01:00:00+08:00' });
    expect(eventDateRange(allDay)).toEqual({ start: '2026-09-24', end: '2026-09-26' });
    expect(eventOccursOnDate(allDay, '2026-09-25')).toBe(true);
    expect(eventOccursOnDate(timed, '2026-09-25')).toBe(true);
    expect(eventOccursOnDate(timed, '2026-09-27')).toBe(false);
  });
});
