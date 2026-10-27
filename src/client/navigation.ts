export type NavKey = 'overview' | 'tasks' | 'calendar' | 'papers' | 'notes' | 'logs' | 'settings';
export interface ViewRoute { section: NavKey; paperId?: string }
const sections = new Set<NavKey>(['overview', 'tasks', 'calendar', 'papers', 'notes', 'logs', 'settings']);

/** Bookmarkable local navigation; legacy translation links lead to the literature library. */
export function parseRoute(hash: string): ViewRoute {
  const value = hash.replace(/^#/, '');
  if (value === 'translations') return { section: 'papers' };
  if (value.startsWith('papers/')) {
    try {
      const paperId = decodeURIComponent(value.slice('papers/'.length));
      return /^[A-Za-z0-9_-]+$/.test(paperId) ? { section: 'papers', paperId } : { section: 'papers' };
    } catch { return { section: 'papers' }; }
  }
  return { section: sections.has(value as NavKey) ? value as NavKey : 'overview' };
}

export function routeHash(route: ViewRoute): string {
  return route.section === 'papers' && route.paperId ? `#papers/${encodeURIComponent(route.paperId)}` : `#${route.section}`;
}
