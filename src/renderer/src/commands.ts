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
  { screen: 'knowledge', label: 'Knowledge', icon: 'knowledge' },
  { screen: 'changes', label: 'Changes', icon: 'pr' },
  { screen: 'progress', label: 'Progress', icon: 'profile' },
] as const;

const sources = { git: 'Local repository', github: 'GitHub repository', topic: 'Topic' };
const kinds = { lesson: 'Lesson', environment: 'Environment', change: 'Change' };

function pathParts(path: string): string[] {
  return path.split(path.startsWith('/') ? '/' : /[\\/]/).filter(Boolean);
}

function localDetails(workspaces: Workspace[]): Map<string, string> {
  const groups = new Map<string, Workspace[]>();
  for (const workspace of workspaces) {
    if (workspace.kind !== 'git' || workspace.source.startsWith('Demo: ')) continue;
    const key = workspace.name.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(workspace);
    else groups.set(key, [workspace]);
  }
  const details = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const paths = group.map(workspace => pathParts(workspace.source));
    group.forEach((workspace, index) => {
      const parts = paths[index];
      if (!parts?.length) throw new Error('A local workspace needs a repository path.');
      for (let length = 1; length < parts.length; length++) {
        const suffix = parts.slice(-length).join('/');
        if (paths.some((other, candidate) => candidate !== index && other.slice(-length).join('/') === suffix)) continue;
        details.set(workspace.id, '…/' + suffix);
        return;
      }
      details.set(workspace.id, workspace.source);
    });
  }
  return details;
}

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
  const details = localDetails(workspaces);
  const work = workspaces.map(item => ({
    id: item.id, label: item.name, detail: details.get(item.id) ?? (item.kind === 'github' && !item.source.startsWith('Demo: ')
      ? item.source : sources[item.kind]), search: `${item.source} ${sources[item.kind]}`,
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
