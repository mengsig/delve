import type { Viewport } from './map-camera';
import type { Depth } from '../../../shared/domain';

export interface Filters {
  workspace: string;
  state: string;
  depth: string;
  query: string;
  group: boolean;
}

export interface KnowledgeView {
  demo: boolean;
  filters: Filters;
  selected: number | null;
  focused: boolean;
  list: boolean;
  finder: boolean;
  details: boolean;
}

export const anyWorkspace = '*';
const filterKey = 'delve.knowledge.filters';

export function savedFilters(activeId?: string): Filters {
  const defaults = { workspace: activeId ?? anyWorkspace, state: '', depth: '', query: '', group: false };
  const raw = localStorage.getItem(filterKey);
  if (!raw) return defaults;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return defaults;
    const saved = value as Record<string, unknown>;
    const state = saved.state === 'not-started' ? 'unstarted' : saved.state;
    return {
      workspace: typeof saved.workspace === 'string' ? saved.workspace || anyWorkspace : defaults.workspace,
      state: typeof state === 'string' && ['mastered', 'verified', 'in-progress', 'ready', 'locked', 'skipped', 'unstarted'].includes(state) ? state : '',
      depth: isDepth(saved.depth) ? saved.depth : '',
      query: typeof saved.query === 'string' ? saved.query : '',
      group: saved.group === true,
    };
  } catch (error) {
    if (error instanceof SyntaxError) return defaults;
    throw error;
  }
}

function isDepth(value: unknown): value is Depth {
  return value === 'high' || value === 'medium' || value === 'low';
}

export function rememberFilters(filters: Filters) {
  localStorage.setItem(filterKey, JSON.stringify(filters));
}

export function knowledgeHistoryView() {
  let saved: KnowledgeView | null = null;
  const cameras = new Map<string, Viewport>();
  const listPositions = new Map<string, number>();
  return { cameras, listPositions, read: () => saved, save: (view: KnowledgeView) => { saved = view; } };
}
