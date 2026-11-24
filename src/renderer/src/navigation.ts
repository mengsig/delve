import { useRef, useState } from 'react';
import type { Depth, Workspace, WorkspaceList } from '../../shared/domain';
import type { LessonAddress } from '../../shared/reader';
import type { ChangeRef, LearnIntent } from '../../shared/repository';
import { call } from './api';
import { dismissOnboarding, onboardingDismissed, storeDepth, workspaceDepth } from './preferences';
import type { Activity } from './recentActivity';
import type { RepositoryJob } from './repository/MapJobs';
import type { AtlasFocus } from './explorer/ChangeAtlas';
import { knowledgeHistoryView } from './knowledge/view';
import { errorMessage } from './useRead';

export type Route =
  | { screen: 'atlas'; focus?: AtlasFocus; conceptId?: number; intent?: LearnIntent }
  | { screen: 'changes'; change?: ChangeRef; title?: string; job?: RepositoryJob }
  | { screen: 'lesson'; conceptId: number; lessonId?: number; lessonDepth?: Depth; question?: string; change?: ChangeRef; environment?: string; review?: boolean }
  | { screen: 'progress'; conceptId?: number }
  | { screen: 'knowledge' }
  | { screen: 'setup' | 'first-run' }
  | { screen: 'baseline'; job?: RepositoryJob };
export type Screen = Route['screen'];

export function routeForActivity(entry: Activity): Route {
  if (entry.kind === 'change') return { screen: 'changes', change: entry.change, title: entry.title };
  return { screen: 'lesson', conceptId: entry.conceptId, lessonId: entry.lessonId,
    lessonDepth: entry.lessonId === undefined ? undefined : entry.depth, change: entry.change,
    environment: entry.kind === 'environment' ? entry.blockKey : undefined };
}

export function routeForTutorJob({ conceptId, depth, lessonId }: LessonAddress): Route {
  return { screen: 'lesson', conceptId, lessonId, lessonDepth: lessonId === undefined ? undefined : depth };
}

function initialRoute(initial: WorkspaceList): Exclude<Route, { screen: 'knowledge' }> {
  if (!initial.activeId || (initial.hasUserWorkspace === false && !onboardingDismissed())) return { screen: 'first-run' };
  return { screen: 'atlas' };
}

type KnowledgeRoute = { screen: 'knowledge'; view: ReturnType<typeof knowledgeHistoryView> };
type HistoryEntry = Exclude<Route, { screen: 'knowledge' }> | KnowledgeRoute;
type KnowledgeDestination = Extract<Route, { screen: 'atlas' | 'lesson' | 'progress' }>;
interface KnowledgeReturn {
  entries: readonly HistoryEntry[];
  workspaceId: string;
  depth: Depth;
}
interface PageHistory {
  entries: readonly HistoryEntry[];
  knowledgeReturn?: KnowledgeReturn;
}

function currentEntry({ entries }: PageHistory): HistoryEntry {
  const entry = entries.at(-1);
  if (!entry) throw new Error('Navigation history must have a current screen.');
  return entry;
}

function createEntry(route: Route): HistoryEntry {
  return route.screen === 'knowledge' ? { ...route, view: knowledgeHistoryView() } : route;
}

export function visitRoute(history: PageHistory, next: Route, replace = false): PageHistory {
  const current = currentEntry(history);
  if (!replace && current.screen === 'knowledge' && next.screen === 'knowledge') return history;
  const entries = replace || current.screen === next.screen && next.screen !== 'lesson'
    ? history.entries.slice(0, -1) : history.entries.slice(-31);
  return { ...history, entries: [...entries, createEntry(next)] };
}

export function beginKnowledgeTrip(history: PageHistory, workspaceId: string, depth: Depth, destination: KnowledgeDestination): PageHistory {
  if (currentEntry(history).screen !== 'knowledge') throw new Error('Open this destination from Knowledge.');
  if (!workspaceId) throw new Error('Select a workspace before opening a Knowledge destination.');
  return { entries: [destination], knowledgeReturn: { entries: history.entries, workspaceId, depth } };
}

export function previousPage(history: PageHistory): PageHistory | KnowledgeReturn {
  if (history.entries.length > 1) return { ...history, entries: history.entries.slice(0, -1) };
  return history.knowledgeReturn ?? { entries: [{ screen: 'atlas' }] };
}

function backToRoute(history: PageHistory, next: Exclude<Route, { screen: 'knowledge' }>): PageHistory {
  const index = history.entries.findLastIndex(entry => entry.screen === next.screen);
  if (index < 0) return { ...history, entries: [next] };
  const prior = history.entries[index];
  const sameChange = next.screen === 'changes' && prior?.screen === 'changes'
    && next.change?.kind === prior.change?.kind && next.change?.ref === prior.change?.ref;
  return { ...history, entries: [...history.entries.slice(0, index), sameChange && prior ? prior : next] };
}

function useActiveWorkspace(initial: WorkspaceList) {
  const [list, setList] = useState(initial);
  const [depth, setDepth] = useState(() => workspaceDepth(initial.activeId ?? ''));
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const switchingTo = useRef(0);
  const active = list.workspaces.find(workspace => workspace.id === list.activeId);

  function apply(next: WorkspaceList, id: string, readingDepth?: Depth) {
    if (readingDepth) storeDepth(id, readingDepth);
    setList(next);
    setDepth(readingDepth ?? workspaceDepth(id));
    setError('');
  }
  async function select(id: string, readingDepth: Depth | undefined, onSelected: () => void) {
    const request = ++switchingTo.current;
    setSwitching(true);
    try {
      const next = await call('workspaces:switch', { id });
      if (request !== switchingTo.current) return false;
      if (next.activeId !== id || !next.workspaces.some(workspace => workspace.id === id)) {
        throw new Error('Could not open this workspace. Choose it again from the switcher.');
      }
      apply(next, id, readingDepth);
      onSelected();
      return true;
    } finally {
      if (request === switchingTo.current) setSwitching(false);
    }
  }
  function activate(workspace: Workspace, readingDepth: Depth) {
    ++switchingTo.current;
    setSwitching(false);
    storeDepth(workspace.id, readingDepth);
    setList(previous => ({
      activeId: workspace.id, hasUserWorkspace: true,
      workspaces: [workspace, ...previous.workspaces.filter(item => item.id !== workspace.id)],
    }));
    setDepth(readingDepth);
    setError('');
  }
  function changeDepth(value: Depth) {
    if (!active) throw new Error('Select a workspace before choosing a reading depth.');
    storeDepth(active.id, value);
    setDepth(value);
  }
  return { select, activate, changeDepth, active, list, depth, error, switching, setError };
}

function usePageHistory(initial: WorkspaceList, workspace: ReturnType<typeof useActiveWorkspace>) {
  const [history, setHistory] = useState<PageHistory>(() => ({ entries: [initialRoute(initial)] }));
  const route = currentEntry(history);
  const origin = history.knowledgeReturn;

  async function restoreKnowledge(origin: KnowledgeReturn) {
    if (workspace.switching) return;
    try {
      if (origin.workspaceId === workspace.active?.id) {
        workspace.changeDepth(origin.depth);
        workspace.setError('');
        setHistory({ entries: origin.entries });
      } else {
        await workspace.select(origin.workspaceId, origin.depth, () => setHistory({ entries: origin.entries }));
      }
    } catch (cause) {
      workspace.setError('Could not return to Knowledge. ' + errorMessage(cause));
    }
  }
  const returnToKnowledge = origin && (() => { void restoreKnowledge(origin); });
  function visit(next: Route, replace = false) {
    setHistory(previous => visitRoute(previous, next, replace));
  }
  function back() {
    if (workspace.switching && (origin || route.screen === 'knowledge')) return;
    if (route.screen === 'first-run') dismissOnboarding();
    const previous = previousPage(history);
    if ('workspaceId' in previous) void restoreKnowledge(previous);
    else setHistory(previous);
  }
  async function openFromKnowledge(id: string, destination: KnowledgeDestination, depth?: Depth) {
    const trip = beginKnowledgeTrip(history, workspace.active?.id ?? '', workspace.depth, destination);
    const selected = await workspace.select(id, depth, () => setHistory(trip));
    if (!selected) throw new Error('Another workspace selection interrupted opening this Knowledge destination.');
  }
  function openPrimary(screen: 'atlas' | 'progress' | 'knowledge' | 'changes' | 'setup') {
    const saved = screen === 'changes' && history.entries.findLast(entry => entry.screen === 'changes');
    visit(saved || { screen });
  }
  function reset(next: Route, keepKnowledgeReturn = false) {
    setHistory(previous => ({
      entries: [createEntry(next)],
      knowledgeReturn: keepKnowledgeReturn ? previous.knowledgeReturn : undefined,
    }));
  }
  return { route, visit, back, openPrimary, reset, openFromKnowledge,
    parentScreen: history.entries.at(-2)?.screen,
    backTo: (next: Exclude<Route, { screen: 'knowledge' }>) => setHistory(previous => backToRoute(previous, next)),
    returnToKnowledge };
}

export function useDesktopNavigation(initial: WorkspaceList) {
  const workspace = useActiveWorkspace(initial);
  const history = usePageHistory(initial, workspace);

  async function select(id: string, route: Route, depth?: Depth) {
    await workspace.select(id, depth, () => {
      if (id === workspace.active?.id) history.visit(route);
      else history.reset(route, history.route.screen === 'progress' && route.screen === 'progress');
    });
  }
  function activate(item: Workspace, route: Route, depth: Depth) {
    workspace.activate(item, depth);
    history.reset(route);
  }
  return { ...workspace, ...history, select, activate };
}

export type DesktopNavigation = ReturnType<typeof useDesktopNavigation>;
