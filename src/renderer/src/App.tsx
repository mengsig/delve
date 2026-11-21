import { useCallback, useEffect, useState } from 'react';
import type { ProviderStatus, WorkspaceList } from '../../shared/domain';
import { call } from './api';
import { AddWorkspaceForm } from './AddWorkspaceForm';

const KIND_LABELS = { git: 'Local Git repository', github: 'GitHub repository', topic: 'Topic' } as const;
const STATE_LABELS: Record<ProviderStatus['state'], string> = {
  'not-found': 'not found',
  'signed-out': 'not signed in',
  'signed-in': 'signed in',
  unknown: 'sign-in state unknown',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Workspaces({ list, onSwitch }: { list: WorkspaceList; onSwitch: (id: string) => void }) {
  if (list.workspaces.length === 0) return <p className="muted">No workspaces yet. Add one below.</p>;
  return (
    <ul aria-label="Workspaces">
      {list.workspaces.map((workspace) => {
        const active = workspace.id === list.activeId;
        return (
          <li key={workspace.id} className={active ? 'active' : undefined} aria-current={active ? 'true' : undefined}>
            <span>{workspace.name}</span>
            <span className="muted">{KIND_LABELS[workspace.kind]}</span>
            {active ? <span>(active)</span> : <button onClick={() => onSwitch(workspace.id)}>Switch to {workspace.name}</button>}
          </li>
        );
      })}
    </ul>
  );
}

function Providers({ statuses }: { statuses: ProviderStatus[] | null }) {
  if (statuses === null) return <p className="muted">Checking installed CLIs…</p>;
  return (
    <ul aria-label="Providers">
      {statuses.map((status) => (
        <li key={status.id} data-provider={status.id} data-state={status.state}>
          <span>{status.id === 'claude' ? 'Claude Code' : 'Codex'}</span>
          <span>{STATE_LABELS[status.state]}</span>
          <span className="muted">{status.version ?? status.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function App() {
  const [list, setList] = useState<WorkspaceList>({ workspaces: [], activeId: null });
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (work: () => Promise<void>) => {
    try {
      setError(null);
      await work();
    } catch (failure) {
      setError(errorText(failure));
    }
  }, []);

  useEffect(() => {
    const report = (failure: unknown) => setError(errorText(failure));
    call('workspaces:list', null).then(setList, report);
    call('providers:detect', null).then(setProviders, report);
  }, []);

  const active = list.workspaces.find((w) => w.id === list.activeId);
  return (
    <main>
      <h1>Delve</h1>
      <p data-testid="active-workspace">{active ? `Active: ${active.name}` : 'No active workspace'}</p>
      {error && <p role="alert" className="error">{error}</p>}
      <section aria-labelledby="workspaces-heading">
        <h2 id="workspaces-heading">Workspaces</h2>
        <Workspaces list={list} onSwitch={(id) => void run(async () => setList(await call('workspaces:switch', { id })))} />
        <AddWorkspaceForm onAdded={() => run(async () => setList(await call('workspaces:list', null)))} onError={setError} />
      </section>
      <section aria-labelledby="providers-heading">
        <h2 id="providers-heading">Providers</h2>
        <Providers statuses={providers} />
      </section>
    </main>
  );
}
