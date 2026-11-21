import { useEffect, useRef, useState } from 'react';
import type { Depth, Workspace, WorkspaceList } from '../../shared/domain';
import { AddWorkspaceForm } from './AddWorkspaceForm';
import { call } from './api';
import { Header, type Screen } from './Header';
import { storeDepth } from './preferences';
import { ReadState } from './ReadState';
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

function Desktop({ initial }: { initial: WorkspaceList }) {
  const [list, setList] = useState(initial);
  const [screen, setScreen] = useState<Screen>(initial.activeId ? 'atlas' : 'setup');
  const [error, setError] = useState('');
  const palette = useSwitcher();
  const main = useRef<HTMLElement>(null);
  const active = list.workspaces.find(workspace => workspace.id === list.activeId);
  useEffect(() => {
    main.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [screen, list.activeId]);

  async function select(id: string, destination: Screen) {
    const next = await call('workspaces:switch', { id });
    setList(next);
    setError('');
    setScreen(destination);
  }
  function added(workspace: Workspace, depth: Depth) {
    storeDepth(workspace.id, depth);
    setList(previous => ({ activeId: workspace.id, workspaces: [workspace, ...previous.workspaces] }));
    setScreen('atlas');
  }
  return <>
    <a className="skip-link" href="#workspace-page">Skip to workspace</a>
    <section className="shell" aria-label="Delve desktop">
      <Header screen={screen} go={setScreen} openSwitcher={palette.show} />
      <main id="workspace-page" ref={main} tabIndex={-1} className="app">
        {error && <p role="alert">{error}</p>}
        <div className="screen" key={list.activeId}>
          {screen === 'setup' || !active ? <AddWorkspaceForm onAdded={added} onCancel={() => setScreen('atlas')} /> :
            <Study workspace={active} workspaces={list.workspaces} screen={screen} go={setScreen} onSwitch={palette.show}
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
