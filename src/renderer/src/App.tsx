import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Depth, Workspace, WorkspaceList } from '../../shared/domain';
import type { LearnIntent } from '../../shared/repository';
import { AddWorkspaceForm } from './AddWorkspaceForm';
import { call } from './api';
import { ContinueActivity, WorkspaceBar } from './atlas/WorkspaceBar';
import { paletteCommands } from './commands';
import { Header } from './Header';
import { routeForActivity, useDesktopNavigation, type DesktopNavigation, type Route } from './navigation';
import { atlasView, workspaceDepth, type AtlasView } from './preferences';
import { useRecentActivity } from './recentActivity';
import { ReadState } from './ReadState';
import { LearnLink } from './repository/LearnLink';
import { MapJobsProvider, useMapJobs, type RepositoryJob } from './repository/MapJobs';
import { MapJobStatus } from './repository/MapJobStatus';
import { Study } from './Study';
import { TutorJobsProvider, TutorJobStatus } from './reader/TutorJobs';
import { isSwitcherShortcut } from './switcher';
import { errorMessage, useRead } from './useRead';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { Knowledge } from './knowledge/Knowledge';
import { useWorkspaceStudy } from './useWorkspaceStudy';

const readWorkspaces = () => call('workspaces:list', null);

function useShortcuts(nav: DesktopNavigation) {
  const [open, setOpen] = useState(false);
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open], [aria-modal="true"]')) return;
    if (isSwitcherShortcut(event, /Mac/i.test(navigator.platform))) {
      event.preventDefault();
      if (!event.repeat) setOpen(true);
    } else if (event.altKey && event.key === 'ArrowLeft') {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return;
      event.preventDefault();
      nav.back();
    } else if (event.key === 'Escape' && nav.route.screen !== 'atlas') {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches('textarea, select')) return target.blur();
      nav.back();
    }
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKey(event);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  return { open, show: () => setOpen(true), hide: () => setOpen(false) };
}

function useStudyDestinations(nav: DesktopNavigation) {
  const [view, setView] = useState(atlasView);
  const { recent, remember } = useRecentActivity();
  const report = (cause: unknown) => nav.setError(errorMessage(cause));
  const select = (id: string) => nav.select(id, { screen: 'atlas' });
  const resume = (entry: typeof recent[number]) => nav.select(entry.workspaceId, routeForActivity(entry), entry.depth);
  function changeView(next: AtlasView) {
    localStorage.setItem('delve.view', next);
    setView(next);
  }
  const { workspaces } = nav.list;
  const commands = paletteCommands({ workspaces, active: nav.active, recent, visit: nav.visit, select, resume,
    showMap: next => { changeView(next); nav.visit({ screen: 'atlas' }); } });
  const last = recent.find(entry => workspaces.some(workspace => workspace.id === entry.workspaceId));
  const workspace = workspaces.find(item => item.id === last?.workspaceId);
  const continueActivity = last && workspace && <ContinueActivity entry={last} workspace={workspace.name}
    onResume={() => void resume(last).catch(report)} />;
  const workspaceBar = nav.active && <WorkspaceBar workspaces={workspaces} activeId={nav.active.id}
    onSwitch={id => { if (id !== nav.list.activeId) void select(id).catch(report); }} />;
  return { view, onView: changeView, remember, commands, continueActivity, workspaceBar };
}

function DesktopJobs({ nav }: { nav: DesktopNavigation }) {
  const jobs = useMapJobs();
  async function openJob(job: RepositoryJob, review: boolean) {
    const route: Route = job.kind === 'change' ? { screen: 'changes', change: job.change, title: job.title, job }
      : review ? { screen: 'baseline', job } : { screen: 'atlas' };
    try {
      await nav.select(job.workspace.id, route, job.depth);
      if (!review) jobs.dismiss(job);
    } catch (cause) { nav.setError(errorMessage(cause)); }
  }
  return <>
    <TutorJobStatus onOpen={({ workspaceId, conceptId, depth }) => nav.select(workspaceId, { screen: 'lesson', conceptId }, depth)} />
    <MapJobStatus onOpen={job => void openJob(job, false)} onReview={job => void openJob(job, true)} />
  </>;
}

function Desktop({ initial }: { initial: WorkspaceList }) {
  const nav = useDesktopNavigation(initial);
  const palette = useShortcuts(nav);
  const destinations = useStudyDestinations(nav);
  const main = useRef<HTMLElement>(null);
  const { active, route } = nav;
  const study = useWorkspaceStudy(active?.id, nav.depth);
  const setup = route.screen === 'setup' || route.screen === 'first-run' || !active;
  useEffect(() => {
    if (!setup) main.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [route.screen, active?.id, setup]);
  function added(workspace: Workspace, depth: Depth, conceptId?: number, notice?: string) {
    nav.activate(workspace, conceptId ? { screen: 'lesson', conceptId } : { screen: 'atlas' }, depth);
    if (notice) nav.setError(notice);
  }
  function accepted(intent: LearnIntent, workspace: Workspace) {
    palette.hide();
    const target: Route = intent.kind === 'proposed' ? { screen: 'atlas', intent }
      : { screen: 'changes', change: { kind: intent.kind, ref: intent.ref } };
    nav.activate(workspace, target, workspaceDepth(workspace.id));
  }
  return <>
    <a className="skip-link" href="#workspace-page">Skip to workspace</a>
    <section className={route.screen === 'lesson' && !setup ? 'shell shell--lesson' : 'shell'} aria-label="Delve desktop">
      <Header screen={route.screen} workspace={active} head={study.head} progress={study.progress} go={nav.openPrimary} openSwitcher={palette.show} />
      <main id="workspace-page" ref={main} tabIndex={-1} className="app">
        {nav.error && <div role="alert">{nav.error} <button onClick={palette.show}>Choose workspace</button> <button onClick={() => nav.setError('')}>Dismiss</button></div>}
        {nav.switching && <span className="workspace-wait" role="status">Opening workspace…</span>}
        <LearnLink onAccepted={accepted} />
        <DesktopJobs nav={nav} />
        <div className="screen" key={active?.id}>
          {route.screen === 'knowledge' ? <Knowledge onOpen={(workspaceId, conceptId, target, depth) => {
            void nav.select(workspaceId, target === 'atlas' ? { screen: 'atlas', conceptId } : { screen: 'lesson', conceptId, review: target === 'review' }, depth)
              .catch(cause => nav.setError(errorMessage(cause)));
          }} /> : setup ? <AddWorkspaceForm onOpenSwitcher={palette.show} onAdded={added} onCancel={active ? nav.back : undefined}
            firstRun={route.screen === 'first-run' || !active} />
            : <Study {...destinations} nav={nav} workspace={active} study={study} onSwitch={palette.show}
              onSelect={id => void nav.select(id, { screen: 'progress' }).catch(cause => nav.setError(errorMessage(cause)))} />}
        </div>
      </main>
    </section>
    {palette.open && <WorkspaceSwitcher commands={destinations.commands} onClose={palette.hide} onAdd={() => nav.visit({ screen: 'setup' })} />}
  </>;
}

export function App() {
  const { result, refresh } = useRead(readWorkspaces);
  if (result.status === 'ready') return <MapJobsProvider><TutorJobsProvider><Desktop initial={result.value} /></TutorJobsProvider></MapJobsProvider>;
  return <main className="shell app"><ReadState label="Workspaces" retry={refresh}
    message={result.status === 'error' ? result.message : undefined} /></main>;
}
