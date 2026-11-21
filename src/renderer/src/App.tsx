import { useEffect, useRef, useState } from 'react';
import type { Depth, Workspace, WorkspaceList } from '../../shared/domain';
import type { LearnIntent } from '../../shared/repository';
import { AddWorkspaceForm } from './AddWorkspaceForm';
import { call } from './api';
import { Header, type Screen } from './Header';
import { dismissOnboarding, onboardingDismissed, storeDepth } from './preferences';
import { ReadState } from './ReadState';
import { LearnLink } from './repository/LearnLink';
import { Study } from './Study';
import { isSwitcherShortcut } from './switcher';
import { errorMessage, useRead } from './useRead';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

const readWorkspaces = () => call('workspaces:list', null);

function useSwitcher() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const mac = /Mac/i.test(navigator.platform);
    function shortcut(event: KeyboardEvent) {
      if (isSwitcherShortcut(event, mac)) {
        event.preventDefault();
        if (!event.repeat) setOpen(true);
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  return { open, show: () => setOpen(true), hide: () => setOpen(false) };
}

function firstScreen(initial: WorkspaceList): Screen {
  if (!initial.activeId || (initial.hasUserWorkspace === false && !onboardingDismissed())) return 'first-run';
  return 'atlas';
}

function useDesktopNavigation(initial: WorkspaceList) {
  const [list, setList] = useState(initial);
  const [screen, setScreen] = useState(() => firstScreen(initial));
  const [error, setError] = useState('');
  const [origin, setOrigin] = useState<{ workspaceId: string; intent: LearnIntent }>();
  const active = list.workspaces.find(workspace => workspace.id === list.activeId);
  async function select(id: string, destination: Screen) {
    const next = await call('workspaces:switch', { id });
    if (next.activeId !== id || !next.workspaces.some(workspace => workspace.id === id)) {
      throw new Error('The selected workspace did not become active.');
    }
    setList(next);
    setError('');
    setScreen(destination);
  }
  function added(workspace: Workspace, depth: Depth) {
    storeDepth(workspace.id, depth);
    activate(workspace, true);
    setScreen((screen === 'first-run' || !active) && workspace.kind !== 'topic' ? 'baseline' : 'atlas');
  }
  function activate(workspace: Workspace, created: boolean) {
    setList(previous => ({
      activeId: workspace.id, hasUserWorkspace: created || previous.hasUserWorkspace,
      workspaces: [workspace, ...previous.workspaces.filter(item => item.id !== workspace.id)],
    }));
    setError('');
  }
  function accepted(intent: LearnIntent, workspace: Workspace) {
    activate(workspace, !list.workspaces.some(item => item.id === workspace.id));
    setOrigin({ workspaceId: workspace.id, intent });
    setScreen(intent.kind === 'proposed' ? 'atlas' : 'changes');
  }
  function cancelSetup() {
    if (screen === 'first-run') dismissOnboarding();
    setScreen('atlas');
  }
  return { list, screen, setScreen, error, setError, origin, active, select, added, accepted, cancelSetup };
}

function Desktop({ initial }: { initial: WorkspaceList }) {
  const { list, screen, setScreen, error, setError, origin, active, select, added, accepted, cancelSetup } = useDesktopNavigation(initial);
  const palette = useSwitcher();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [screen, list.activeId]);

  return <>
    <a className="skip-link" href="#workspace-page">Skip to workspace</a>
    <section className="shell" aria-label="Delve desktop">
      <Header screen={screen} go={setScreen} openSwitcher={palette.show} />
      <main id="workspace-page" ref={main} tabIndex={-1} className="app">
        {error && <p role="alert">{error}</p>}
        <LearnLink onAccepted={(intent, workspace) => { palette.hide(); accepted(intent, workspace); }} />
        <div className="screen" key={list.activeId}>
          {screen === 'setup' || screen === 'first-run' || !active
            ? <AddWorkspaceForm onAdded={added} onCancel={active ? cancelSetup : undefined}
              firstRun={screen === 'first-run' || !active} />
            : <Study workspace={active} workspaces={list.workspaces} screen={screen} go={setScreen} onSwitch={palette.show}
              intent={origin?.workspaceId === active.id ? origin?.intent : undefined}
              onSelect={id => void select(id, 'progress').catch(cause => setError(errorMessage(cause)))} />}
        </div>
      </main>
    </section>
    {palette.open && <WorkspaceSwitcher activeId={list.activeId} workspaces={list.workspaces} onClose={palette.hide}
      onSelect={id => select(id, 'atlas')} onAdd={() => setScreen('setup')} />}
  </>;
}

export function App() {
  const { result, refresh } = useRead(readWorkspaces);
  if (result.status === 'ready') return <Desktop initial={result.value} />;
  return <main className="shell app"><ReadState label="Workspaces" retry={refresh}
    message={result.status === 'error' ? result.message : undefined} /></main>;
}
