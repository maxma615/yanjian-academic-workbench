import { expect, it } from 'vitest';
import { parseRoute, routeHash } from '../../src/client/navigation';

it('keeps paper reading routes scoped to the specified paper and canonicalizes the former translation entry', () => {
  expect(parseRoute('#papers/paper-123')).toEqual({ section: 'papers', paperId: 'paper-123' });
  expect(routeHash(parseRoute('#papers/paper-123'))).toBe('#papers/paper-123');
  expect(parseRoute('#translations')).toEqual({ section: 'papers' });
  expect(routeHash(parseRoute('#translations'))).toBe('#papers');
});

it('handles malformed and unknown routes without guessing a paper or throwing', () => {
  for (const hash of ['#papers/', '#papers/%E0%A4%A', '#papers/one/two', '#papers/%2Foutside']) {
    expect(parseRoute(hash)).toEqual({ section: 'papers' });
  }
  expect(parseRoute('#unrelated')).toEqual({ section: 'overview' });
  expect(parseRoute('')).toEqual({ section: 'overview' });
  expect(parseRoute('#notes')).toEqual({ section: 'notes' });
});
