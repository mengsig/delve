import { useMemo } from 'react';
import type { Workspace } from '../../../shared/domain';
import type { Activity } from '../recentActivity';
import { Icon } from '../Icon';

export function WorkspaceBar({ workspaces, activeId, onSwitch }: {
  workspaces: Workspace[]; activeId: string; onSwitch: (id: string) => void;
}) {
  const ordered = useMemo(() => workspaces.toSorted((left, right) => left.name.localeCompare(right.name)), [workspaces]);
  return <div className="workspace-bar" role="group" aria-label="Your workspaces">
    <span className="plate">Workspaces</span>
    <div className="workspace-tabs">
      {ordered.map(workspace => <button key={workspace.id} type="button" aria-pressed={workspace.id === activeId}
        onClick={() => onSwitch(workspace.id)}>{workspace.name}</button>)}
    </div>
  </div>;
}

export function ContinueActivity({ entry, workspace, onResume }: { entry: Activity; workspace: string; onResume: () => void }) {
  return <button className="continue-activity" type="button" onClick={onResume}>
    <span className="ico-box"><Icon name={entry.kind === 'change' ? 'pr' : entry.kind === 'environment' ? 'frame' : 'book'} /></span>
    <span><span className="eyebrow">Continue {entry.kind}</span><strong>{entry.title}</strong>{workspace !== entry.title && <small>{workspace}</small>}</span>
    <span className="arr" aria-hidden="true">→</span>
  </button>;
}
