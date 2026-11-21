import { useCallback, useEffect, type ReactNode } from 'react';
import type { Workspace } from '../../shared/domain';
import type { WorkspaceGraph } from '../../shared/graph';
import type { ChangeRef } from '../../shared/repository';
import { demoBrief } from '../../shared/reader-demo';
import { call } from './api';
import { ChangeAtlas } from './explorer/ChangeAtlas';
import { EnvironmentActivity } from './lab/EnvironmentActivity';
import type { DesktopNavigation, Route } from './navigation';
import type { AtlasView } from './preferences';
import { Progress } from './progress/Progress';
import { Changes } from './reader/Changes';
import { Lesson } from './reader/Lesson';
import type { ReaderProps } from './reader/ReaderHeader';
import type { Activity } from './recentActivity';
import { ReadState } from './ReadState';
import { useRepositoryCompletion } from './repository/MapJobs';
import { ProposedContext } from './repository/ProposedContext';
import { RepositoryBaseline } from './repository/RepositoryBaseline';
import { useRead } from './useRead';

interface Props {
  workspace: Workspace;
  nav: DesktopNavigation;
  view: AtlasView;
  onView: (next: AtlasView) => void;
  workspaceBar: ReactNode;
  continueActivity: ReactNode;
  onSwitch: () => void;
  onSelect: (id: string) => void;
  remember: (entry: Activity) => void;
}
type LessonRoute = Extract<Route, {screen: 'lesson'}>;
type ChangeRoute = Extract<Route, {screen: 'changes'}>;

function StudyLesson({ route, common, remember, refresh, visit }: {
  route: LessonRoute; common: ReaderProps; remember: Props['remember']; refresh: () => void; visit: DesktopNavigation['visit'];
}) {
  const { conceptId, change, environment } = route;
  const { depth, workspace, graph } = common;
  const title = graph.concepts.find(concept => concept.id === conceptId)?.title;
  const workspaceId = workspace.id;
  useEffect(() => {
    if (title && !environment) remember({ kind: 'lesson', workspaceId, conceptId, depth, title, change });
  }, [title, environment, remember, workspaceId, conceptId, depth, change]);
  function used(blockKey: string, name: string) {
    remember({ kind: 'environment', workspaceId, conceptId, depth, title: name, blockKey, change });
  }
  return <EnvironmentActivity.Provider value={{ resumeKey: environment, onUse: used }}>
    <Lesson {...common} conceptId={conceptId} initialQuestion={route.question} onEvidence={refresh}
      onBack={() => visit({ screen: 'atlas', conceptId })}
      onBackToChange={change ? () => visit({ screen: 'changes', change }) : undefined} />
  </EnvironmentActivity.Provider>;
}

function StudyChanges({ route, common, remember, visit }: {
  route: ChangeRoute; common: ReaderProps; remember: Props['remember']; visit: DesktopNavigation['visit'];
}) {
  const { workspace, graph, depth } = common;
  const { change, title, job } = route;
  const demo = graph.demo && graph.snapshot === demoBrief.head;
  useEffect(() => {
    if (change) {
      const label = change.kind === 'pr' ? 'PR #' + change.ref : 'Commit ' + change.ref.slice(0, 8);
      remember({ kind: 'change', workspaceId: workspace.id, depth, change, title: title ?? label });
    } else if (demo) remember({ kind: 'change', workspaceId: workspace.id, depth,
      change: { kind: 'pr', ref: '184' }, title: 'Reject late worker results' });
  }, [change, title, workspace.id, depth, demo, remember]);
  return <Changes {...common} selected={change} openedJob={job?.kind === 'change' ? job : undefined}
    onSelect={(selection: ChangeRef, label?: string) => visit({ screen: 'changes', change: selection, title: label }, true)}
    onLesson={conceptId => visit({ screen: 'lesson', conceptId, change: change ?? (demo ? { kind: 'pr', ref: '184' } : undefined) })}
    onAtlas={id => visit({ screen: 'atlas', focus: change ? { id, change } : undefined })} />;
}

function StudyPage({ props, graph, refresh }: { props: Props; graph: WorkspaceGraph; refresh: () => void }) {
  const { workspace, view, onView, nav, remember, onSelect } = props;
  const { route, visit, depth, changeDepth } = nav;
  const openLesson = (conceptId: number, question?: string) => visit({ screen: 'lesson', conceptId, question });
  const common = { workspace, graph, depth, view, onDepth: changeDepth, onBack: () => visit({ screen: 'atlas' }), onLesson: openLesson };
  if (route.screen === 'lesson') return <StudyLesson key={route.conceptId} route={route} common={common} remember={remember} refresh={refresh} visit={visit} />;
  if (route.screen === 'changes') return <StudyChanges route={route} common={common} remember={remember} visit={visit} />;
  if (route.screen === 'progress') return <Progress {...common} workspaces={nav.list.workspaces} onSelect={onSelect} onEvidence={refresh} />;
  const atlas = route.screen === 'atlas' ? route : undefined;
  async function startTopic() {
    const conceptId = await call('reader:start-topic', { workspaceId: workspace.id });
    refresh();
    openLesson(conceptId);
  }
  return <>
    {atlas?.intent?.kind === 'proposed' && <ProposedContext intent={atlas.intent} graph={graph} depth={depth} onLesson={openLesson} />}
    <ChangeAtlas {...common} focus={atlas?.focus} onClearFocus={common.onBack} initialConceptId={atlas?.conceptId}
      onView={onView} onChanges={change => visit({ screen: 'changes', change })}
      onStartTopic={startTopic} onProgress={() => visit({ screen: 'progress' })} onSwitch={props.onSwitch}
      continueActivity={props.continueActivity} workspaceBar={props.workspaceBar} onMap={() => visit({ screen: 'baseline' })} />
  </>;
}

export function Study(props: Props) {
  const { workspace, nav, view } = props;
  const { route, depth } = nav;
  const workspaceId = workspace.id;
  const includeChangeLessons = route.screen === 'lesson' || route.screen === 'progress';
  const query = useCallback(() => call('graph:read', { workspaceId, includeChangeLessons }), [workspaceId, includeChangeLessons]);
  const { result, refresh } = useRead(query);
  useRepositoryCompletion(workspaceId, refresh);
  if (route.screen === 'baseline' && workspace.kind !== 'topic') {
    const reviewJob = route.job?.kind === 'map' && route.job.phase === 'failed' ? route.job : undefined;
    return <RepositoryBaseline workspace={workspace} depth={depth} onDepth={nav.changeDepth}
      onBack={() => nav.visit({ screen: 'atlas' })} reviewJob={reviewJob} />;
  }
  if (result.status !== 'ready') return <ReadState label="Knowledge graph" retry={refresh}
    message={result.status === 'error' ? result.message : undefined} />;
  return <div className={view}><StudyPage props={props} graph={result.value} refresh={refresh} /></div>;
}
