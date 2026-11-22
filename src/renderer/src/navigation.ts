import { useRef, useState } from 'react';
import type { Depth, Workspace, WorkspaceList } from '../../shared/domain';
import type { ChangeRef, LearnIntent } from '../../shared/repository';
import { call } from './api';
import { dismissOnboarding, onboardingDismissed, storeDepth, workspaceDepth } from './preferences';
import type { Activity } from './recentActivity';
import type { RepositoryJob } from './repository/MapJobs';
import type { AtlasFocus } from './explorer/ChangeAtlas';

export type Route =
  | { screen: 'atlas'; focus?: AtlasFocus; conceptId?: number; intent?: LearnIntent }
  | { screen: 'changes'; change?: ChangeRef; title?: string; job?: RepositoryJob }
  | { screen: 'lesson'; conceptId: number; question?: string; change?: ChangeRef; environment?: string; review?: boolean }
  | { screen: 'progress'; conceptId?: number }
  | { screen: 'knowledge' | 'setup' | 'first-run' }
  | { screen: 'baseline'; job?: RepositoryJob };
export type Screen = Route['screen'];

export function routeForActivity(entry: Activity): Route {
  if (entry.kind === 'change') return { screen: 'changes', change: entry.change, title: entry.title };
  return { screen: 'lesson', conceptId: entry.conceptId, change: entry.change,
    environment: entry.kind === 'environment' ? entry.blockKey : undefined };
}

function initialRoute(initial: WorkspaceList): Route {
  if (!initial.activeId || (initial.hasUserWorkspace === false && !onboardingDismissed())) return { screen: 'first-run' };
  return { screen: 'atlas' };
}

function usePageHistory(initial: WorkspaceList) {
  const [stack, setStack] = useState<Route[]>(() => [initialRoute(initial)]);
  const route = stack[stack.length - 1]!;
  function visit(next: Route, replace = false) {
    setStack(previous => {
      const current = previous[previous.length - 1]!;
      if (replace || current.screen === next.screen && next.screen !== 'lesson') return [...previous.slice(0, -1), next];
      return [...previous.slice(-31), next];
    });
  }
  function back() {
    if (route.screen === 'first-run') dismissOnboarding();
    setStack(previous => previous.length > 1 ? previous.slice(0, -1) : [{ screen: 'atlas' }]);
  }
  function backTo(next: Route) {
    setStack(previous => {
      const index = previous.findLastIndex(entry => entry.screen === next.screen);
      if (index < 0) return [next];
      const prior = previous[index];
      const sameChange = next.screen === 'changes' && prior?.screen === 'changes'
        && next.change?.kind === prior.change?.kind && next.change?.ref === prior.change?.ref;
      return [...previous.slice(0, index), sameChange ? prior : next];
    });
  }
  function openPrimary(screen: 'atlas' | 'progress' | 'knowledge' | 'changes' | 'setup') {
    const saved = screen === 'changes' && stack.findLast(entry => entry.screen === 'changes');
    visit(saved || { screen });
  }
  return { route, visit, back, backTo, openPrimary, reset: (next: Route) => setStack([next]) };
}

export function useDesktopNavigation(initial: WorkspaceList) {
  const history = usePageHistory(initial);
  const [list, setList] = useState(initial);
  const [depth, setDepth] = useState(() => workspaceDepth(initial.activeId ?? ''));
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const switchingTo = useRef(0);
  const active = list.workspaces.find(workspace => workspace.id === list.activeId);

  async function select(id: string, route: Route, readingDepth?: Depth) {
    const request = ++switchingTo.current;
    setSwitching(true);
    try {
      const next = await call('workspaces:switch', { id });
      if (request !== switchingTo.current) return;
      if (next.activeId !== id || !next.workspaces.some(workspace => workspace.id === id)) {
        throw new Error('Could not open this workspace. Choose it again from the switcher.');
      }
      setList(next);
      if (readingDepth) storeDepth(id, readingDepth);
      setDepth(readingDepth ?? workspaceDepth(id));
      if (id === list.activeId) history.visit(route);
      else history.reset(route);
      setError('');
    } finally {
      if (request === switchingTo.current) setSwitching(false);
    }
  }
  function activate(workspace: Workspace, route: Route, readingDepth: Depth) {
    ++switchingTo.current;
    setSwitching(false);
    setList(previous => ({
      activeId: workspace.id, hasUserWorkspace: true,
      workspaces: [workspace, ...previous.workspaces.filter(item => item.id !== workspace.id)],
    }));
    storeDepth(workspace.id, readingDepth);
    setDepth(readingDepth);
    setError('');
    history.reset(route);
  }
  function changeDepth(value: Depth) {
    if (!active) throw new Error('Select a workspace before choosing a reading depth.');
    storeDepth(active.id, value);
    setDepth(value);
  }
  return { ...history, active, list, depth, error, switching, setError, changeDepth, select, activate };
}

export type DesktopNavigation = ReturnType<typeof useDesktopNavigation>;
