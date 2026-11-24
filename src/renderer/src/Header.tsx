import type { Workspace } from '../../shared/domain';
import type { WorkspaceHead } from '../../shared/graph';
import { Icon } from './Icon';
import { ThemeButton } from './ThemeButton';

import { primaryViews } from './commands';
import type { Screen } from './navigation';
import { useRef } from 'react';
import { WorkspaceMeter } from './progress/ProgressMeters';
import type { LearningProgress } from './progress/model';

declare const __DELVE_VERSION__: string;

type HeaderScreen = typeof primaryViews[number]['screen'] | 'setup';

const locations: Record<Screen, string> = {
  atlas: 'Atlas', lesson: 'Study / Lesson', knowledge: 'Knowledge · All workspaces',
  changes: 'Changes', progress: 'Progress', baseline: 'Map repository', setup: 'Workspace setup', 'first-run': 'Getting started',
};

function headLabel(head?: WorkspaceHead): string {
  if (!head) return 'Reading workspace…';
  if (head.kind === 'topic') return 'Topic';
  if (head.kind === 'demo') return 'Demo snapshot';
  if (head.kind === 'branch') return head.branch + (head.cached ? ' · cached' : '');
  if (head.kind === 'detached') return 'Detached · ' + head.commit.slice(0, 8) + (head.cached ? ' · cached' : '');
  return 'Branch unavailable';
}

interface Props {
  screen: Screen;
  lab: boolean;
  workspace?: Workspace;
  head?: WorkspaceHead;
  progress?: LearningProgress;
  go: (screen: HeaderScreen) => void;
  openSwitcher: () => void;
}

export function Header({ screen, lab, workspace, head, progress, go, openSwitcher }: Props) {
  const about = useRef<HTMLDialogElement>(null);
  const context = workspace ? headLabel(head) : undefined;
  const displayName = workspace?.kind === 'github' && head?.kind !== 'demo' && !workspace.source.startsWith('Demo: ')
    ? workspace.source : workspace?.name;
  return <header className="windowbar">
    <button className="brand" onClick={openSwitcher} aria-label="Switch workspace" aria-describedby="active-workspace"
      aria-haspopup="dialog" title={[displayName, context, 'Switch workspace (Ctrl or ⌘ K)'].filter(Boolean).join(' · ')}>
      <svg className="mark" viewBox="0 0 36 36" aria-hidden="true">
        <path d="M2 14 18 4l16 10-16 10z" fill="currentColor" />
        <path d="m3 19 15 9 15-9M3 24l15 9 15-9" stroke="currentColor" fill="none" strokeWidth="2.8" strokeLinejoin="round" />
        <path d="m18 9 6 4-6 4-6-4z" fill="var(--surface)" />
      </svg>
      <span className="brand-name">Delve</span>
      <span className="workspace-identity" id="active-workspace">
        <strong>{displayName ?? 'Choose a workspace'}</strong>
        {context && <small>{context}</small>}
      </span>
      <span className="workspace-chevron" aria-hidden="true">⌄</span>
    </button>
    <nav className="appnav" aria-label="Application">
      {primaryViews.map(link => <button key={link.screen} aria-current={screen === link.screen ? 'page' : screen === 'lesson' && link.screen === 'atlas' ? 'location' : undefined} onClick={() => go(link.screen)}>
        <Icon name={link.icon} />{link.label}
      </button>)}
    </nav>
    <div className="shell-location">{primaryViews.some(link => link.screen === screen) && screen !== 'knowledge' ? null : lab ? 'Study / Lab' : locations[screen]}</div>
    {workspace && <div className="shell-mastery"><WorkspaceMeter progress={progress}
      label={screen === 'knowledge' ? 'Workspace mastery · Atlas' : undefined} /></div>}
    <div className="row window-tools">
      <button className="tool" onClick={() => go('setup')} aria-label="Add a workspace" title="Add a workspace">+</button>
      <ThemeButton />
      <button className="tool" onClick={() => about.current?.showModal()} aria-label="About" title="About Delve">···</button>
      <dialog ref={about} className="workspace-palette" aria-labelledby="about-title">
        <div className="palette-header"><h2 id="about-title">About Delve</h2></div>
        <p>Delve {__DELVE_VERSION__}</p>
        <p>Learn the codebase your agents are building.</p>
        <form method="dialog"><button autoFocus>Close</button></form>
      </dialog>
    </div>
  </header>;
}
