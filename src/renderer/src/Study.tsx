import { useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { Workspace } from '../../shared/domain';
import type { ReaderLesson } from '../../shared/reader';
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
import { ProposedContext } from './repository/ProposedContext';
import { RepositoryBaseline } from './repository/RepositoryBaseline';
import { atlasGraph, type WorkspaceStudy } from './useWorkspaceStudy';

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
  study: WorkspaceStudy;
}
type LessonRoute = Extract<Route, {screen: 'lesson'}>;
type ChangeRoute = Extract<Route, {screen: 'changes'}>;

function StudyLesson({ route, common, remember, commit, refresh, backTo }: {
  route: LessonRoute; common: ReaderProps; remember: Props['remember']; commit: WorkspaceStudy['commit'];
  refresh: WorkspaceStudy['refresh'];
  backTo: DesktopNavigation['backTo'];
}) {
  const { conceptId, change, environment } = route;
  const { depth, workspace, graph } = common;
  const title = graph.concepts.find(concept => concept.id === conceptId)?.title;
  const workspaceId = workspace.id;
  useLayoutEffect(() => {
    if (title && !environment) remember({ kind: 'lesson', workspaceId, conceptId, depth, title, change });
  }, [title, environment, remember, workspaceId, conceptId, depth, change]);
  function read() {
    if (title) remember({ kind: 'lesson', workspaceId, conceptId, depth, title, change });
  }
  function used(blockKey: string, name: string) {
    remember({ kind: 'environment', workspaceId, conceptId, depth, title: name, blockKey, change });
  }
  function onEvidence(lesson?: ReaderLesson) {
    if (lesson) commit({ workspaceId, conceptId, depth }, lesson);
    else refresh();
  }
  return <EnvironmentActivity.Provider value={{ resumeKey: environment, onUse: used, onRead: read }}>
    <Lesson {...common} conceptId={conceptId} initialQuestion={route.question} initialReview={route.review} onEvidence={onEvidence}
      onBack={common.backLabel ? common.onBack : () => backTo({ screen: 'atlas', conceptId })}
      onBackToChange={change ? () => backTo({ screen: 'changes', change }) : undefined} />
  </EnvironmentActivity.Provider>;
}

function StudyChanges({ route, common, remember, visit }: {
  route: ChangeRoute; common: ReaderProps; remember: Props['remember']; visit: DesktopNavigation['visit'];
}) {
  const { workspace, graph, depth } = common;
  const { change, title, job } = route;
  const demo = graph.demo && graph.snapshot === demoBrief.head;
  useLayoutEffect(() => {
    if (change) {
      const label = change.kind === 'pr' ? 'PR #' + change.ref : 'Commit ' + change.ref.slice(0, 8);
      remember({ kind: 'change', workspaceId: workspace.id, depth, change, title: title ?? label });
    } else if (demo) remember({ kind: 'change', workspaceId: workspace.id, depth,
      change: { kind: 'pr', ref: '184' }, title: 'Reject late worker results' });
  }, [change, title, workspace.id, depth, demo, remember]);
  return <Changes {...common} onAdd={() => visit({ screen: 'setup' })} selected={change} openedJob={job?.kind === 'change' ? job : undefined}
    onSelect={(selection?: ChangeRef, label?: string) => visit({ screen: 'changes', change: selection, title: label }, true)}
    onLesson={conceptId => visit({ screen: 'lesson', conceptId, change: change ?? (demo ? { kind: 'pr', ref: '184' } : undefined) })}
    onAtlas={id => visit({ screen: 'atlas', focus: change ? { id, change } : undefined })} />;
}

function StudyPage({ props, fullGraph }: { props: Props; fullGraph: NonNullable<WorkspaceStudy['graph']> }) {
  const { workspace, view, onView, nav, remember, onSelect, study } = props;
  const { route, visit, depth, changeDepth } = nav;
  const atlasOnly = useMemo(() => atlasGraph(fullGraph), [fullGraph]);
  const graph = route.screen === 'lesson' || route.screen === 'progress' ? fullGraph : atlasOnly;
  const activeConceptId = route.screen === 'lesson' ? route.conceptId : undefined;
  const openLesson = (conceptId: number, question?: string) => visit({ screen: 'lesson', conceptId, question });
  const toAtlas = () => nav.backTo({ screen: 'atlas' });
  const returnToKnowledge = route.screen === 'lesson' || route.screen === 'progress' ? nav.returnToKnowledge : undefined;
  const common: ReaderProps = { workspace, graph, depth, view, onDepth: changeDepth,
    onBack: returnToKnowledge ?? toAtlas, backLabel: returnToKnowledge ? '← Back to Knowledge' : undefined,
    onLesson: openLesson, onProgress: () => visit({ screen: 'progress', conceptId: activeConceptId }) };
  if (route.screen === 'lesson') return <StudyLesson key={route.conceptId} route={route} common={common} remember={remember}
    commit={study.commit} refresh={study.refresh} backTo={nav.backTo} />;
  if (route.screen === 'changes') return <StudyChanges route={route} common={common} remember={remember} visit={visit} />;
  if (route.screen === 'progress') return <Progress {...common} progress={study.progress} currentId={route.conceptId}
    workspaces={nav.list.workspaces} onSelect={onSelect} onExplore={toAtlas} onEvidence={study.refresh} />;
  const atlas = route.screen === 'atlas' ? route : undefined;
  async function startTopic() {
    const conceptId = await call('reader:start-topic', { workspaceId: workspace.id });
    study.refresh();
    openLesson(conceptId);
  }
  return <>
    {atlas?.intent?.kind === 'proposed' && <ProposedContext intent={atlas.intent} graph={graph} depth={depth} onLesson={openLesson} />}
    <ChangeAtlas {...common} focus={atlas?.focus} onClearFocus={() => visit({ screen: 'atlas' }, true)} initialConceptId={atlas?.conceptId}
      onView={onView} onChanges={change => visit({ screen: 'changes', change })}
      onStartTopic={startTopic} onSwitch={props.onSwitch}
      continueActivity={props.continueActivity} workspaceBar={props.workspaceBar} onMap={() => visit({ screen: 'baseline' })} />
  </>;
}

export function Study(props: Props) {
  const { workspace, nav, view, study } = props;
  const { route, depth } = nav;
  if (route.screen === 'baseline' && workspace.kind !== 'topic') {
    const reviewJob = route.job?.kind === 'map' && route.job.phase === 'failed' ? route.job : undefined;
    return <RepositoryBaseline workspace={workspace} depth={depth} onDepth={nav.changeDepth}
      onBack={() => nav.backTo({ screen: 'atlas' })} reviewJob={reviewJob} />;
  }
  const showBack = nav.returnToKnowledge && (route.screen === 'atlas' || !study.graph);
  return <>
    {showBack && <button className="back" onClick={nav.returnToKnowledge} disabled={nav.switching}>← Back to Knowledge</button>}
    {study.graph ? <div className={view}><StudyPage props={props} fullGraph={study.graph} /></div>
      : <ReadState label="Knowledge graph" retry={study.refresh} message={study.error} />}
  </>;
}
