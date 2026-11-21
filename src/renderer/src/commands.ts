import type { Workspace } from '../../shared/domain';
import type { Activity } from './recentActivity';
import { activityKey } from './recentActivity';
import type { Route } from './navigation';

export interface Command {
  id: string;
  label: string;
  detail: string;
  search?: string;
  current?: boolean;
  open: () => Promise<void> | void;
}
export const primaryViews = [
  { screen: 'atlas', label: 'Atlas', icon: 'atlas' },
  { screen: 'changes', label: 'Changes', icon: 'pr' },
  { screen: 'progress', label: 'Progress', icon: 'profile' },
] as const;

const sources = { git: 'Local repository', github: 'GitHub repository', topic: 'Topic' };
const kinds = { lesson: 'Lesson', environment: 'Environment', change: 'Change' };
interface Destinations {
  workspaces: Workspace[];
  active?: Workspace;
  recent: Activity[];
  visit: (route: Route) => void;
  select: (id: string) => Promise<void>;
  resume: (entry: Activity) => Promise<void>;
  showMap: (view: 'contour' | 'folio') => void;
}

export function paletteCommands({ workspaces, active, recent, visit, select, resume, showMap }: Destinations): Command[] {
  const work = workspaces.map(item => ({
    id: item.id, label: item.name, detail: sources[item.kind], search: item.source,
    current: item.id === active?.id, open: () => select(item.id),
  }));
  const views: Command[] = primaryViews.map(({ screen, label }) => ({
    id: screen, label, detail: 'View', open: () => visit({ screen }),
  }));
  views.push(
    { id: 'contour', label: 'Terrain map', detail: 'Atlas view', open: () => showMap('contour') },
    { id: 'folio', label: 'Folio ledger', detail: 'Atlas view', open: () => showMap('folio') },
    { id: 'add', label: 'Add a workspace', detail: 'Topic or repository', open: () => visit({ screen: 'setup' }) },
    { id: 'first-run', label: 'Getting started', detail: 'Workspace setup', open: () => visit({ screen: 'first-run' }) },
  );
  if (active && active.kind !== 'topic' && !active.source.startsWith('Demo: ')) views.push({
    id: 'baseline', label: 'Map repository files', detail: active.name, open: () => visit({ screen: 'baseline' }),
  });
  const saved = recent.flatMap(entry => {
    const workspace = workspaces.find(item => item.id === entry.workspaceId);
    return workspace ? [{ id: activityKey(entry), label: entry.title,
      detail: `${kinds[entry.kind]} · ${workspace.name}`, open: () => resume(entry) }] : [];
  });
  return [...work, ...saved, ...views];
}
