import { useCallback, useState } from 'react';
import type { Depth, Workspace } from '../../shared/domain';
import type { ChangeRef, LearnIntent } from '../../shared/repository';
import { call } from './api';
import { ChangeAtlas, type AtlasFocus } from './explorer/ChangeAtlas';
import type { Screen } from './Header';
import { atlasView, storeDepth, workspaceDepth, type AtlasView } from './preferences';
import { Progress } from './progress/Progress';
import { Changes } from './reader/Changes';
import { Lesson } from './reader/Lesson';
import { ReadState } from './ReadState';
import { useRepositoryCompletion, type RepositoryJob } from './repository/MapJobs';
import { ProposedContext } from './repository/ProposedContext';
import { RepositoryBaseline } from './repository/RepositoryBaseline';
import { useRead } from './useRead';

interface Props {
  workspace: Workspace;
  workspaces: Workspace[];
  screen: Screen;
  go: (screen: Screen) => void;
  onSwitch: () => void;
  onSelect: (id: string) => void;
  intent?: LearnIntent;
  openedJob?: RepositoryJob;
}

function useStudyGraph(workspaceId: string, includeChangeLessons: boolean) {
  const readGraph = useCallback(() => {
    const request = { workspaceId, includeChangeLessons };
    return call('graph:read', request);
  }, [workspaceId, includeChangeLessons]);
  const read = useRead(readGraph);
  useRepositoryCompletion(workspaceId, read.refresh);
  return read;
}

export function Study({ workspace, workspaces, screen, go, onSwitch, onSelect, intent, openedJob }: Props) {
  const [depth, setDepth] = useState(() => openedJob?.depth ?? workspaceDepth(workspace.id));
  const [atlasFocus, setAtlasFocus] = useState<AtlasFocus>();
  const [view, setView] = useState(atlasView);
  const [lesson, setLesson] = useState<{ id: number; question?: string; fromChange?: boolean }>();
  const [changeSelection, setChangeSelection] = useState<{ change: ChangeRef; intentId?: string } | undefined>(() =>
    openedJob?.kind === 'change' ? { change: openedJob.change, intentId: intent?.id } : undefined);
  const linkedChange: ChangeRef | undefined = intent?.kind === 'commit' || intent?.kind === 'pr' ? { kind: intent.kind, ref: intent.ref } : undefined;
  const selected = changeSelection?.intentId === intent?.id ? changeSelection?.change ?? linkedChange : linkedChange;
  const { result, refresh } = useStudyGraph(workspace.id, screen === 'lesson' || screen === 'progress');
  function changeDepth(next: Depth) {
    storeDepth(workspace.id, next);
    setDepth(next);
  }
  function changeView(next: AtlasView) {
    localStorage.setItem('delve.view', next);
    setView(next);
  }
  function openLesson(id: number, question?: string, fromChange = false) {
    setAtlasFocus(undefined);
    setLesson({ id, question, fromChange });
    go('lesson');
  }
  function selectChange(change: ChangeRef) {
    setChangeSelection({ change, intentId: intent?.id });
  }
  function openChanges(change?: ChangeRef) {
    if (change) selectChange(change);
    go('changes');
  }
  async function startTopic() {
    const id = await call('reader:start-topic', { workspaceId: workspace.id });
    refresh();
    openLesson(id);
  }
  if (screen === 'baseline' && workspace.kind !== 'topic') {
    const reviewJob = openedJob?.kind === 'map' && openedJob.phase === 'failed' ? openedJob : undefined;
    return <RepositoryBaseline workspace={workspace} depth={depth} onDepth={changeDepth}
      onBack={() => go('atlas')} reviewJob={reviewJob} />;
  }
  if (result.status !== 'ready') return <ReadState label="Knowledge graph" retry={refresh}
    message={result.status === 'error' ? result.message : undefined} />;

  const common = { workspace, graph: result.value, depth, view, onDepth: changeDepth, onBack: () => go('atlas'), onLesson: openLesson };
  return <div className={view}>
    {screen === 'atlas' && intent?.kind === 'proposed' && <ProposedContext intent={intent} graph={result.value} depth={depth} onLesson={openLesson} />}
    {screen === 'lesson' && lesson ? <Lesson {...common} conceptId={lesson.id} initialQuestion={lesson.question} onEvidence={refresh}
      onBackToChange={lesson.fromChange ? () => go('changes') : undefined} /> :
      screen === 'changes' ? <Changes {...common} selected={selected}
        openedJob={openedJob?.kind === 'change' ? openedJob : undefined}
        onSelect={selectChange} onLesson={id => openLesson(id, undefined, true)}
        onAtlas={id => { if (selected) setAtlasFocus({ id, change: selected }); go('atlas'); }} /> :
      screen === 'progress' ? <Progress {...common} workspaces={workspaces} onSelect={onSelect} onEvidence={refresh} /> :
      <ChangeAtlas {...common} focus={atlasFocus} onClearFocus={() => setAtlasFocus(undefined)} initialConceptId={lesson?.id} onView={changeView} onChanges={openChanges}
        onStartTopic={startTopic} onProgress={() => go('progress')} onSwitch={onSwitch} onAdd={() => go('setup')}
        onFirstRun={() => go('first-run')} onMap={() => go('baseline')} />}
  </div>;
}
