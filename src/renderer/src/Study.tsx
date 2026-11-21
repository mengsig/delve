import { useCallback, useState } from 'react';
import type { Depth, Workspace } from '../../shared/domain';
import type { ChangeRef, LearnIntent } from '../../shared/repository';
import { call } from './api';
import { Atlas } from './atlas/Atlas';
import type { Screen } from './Header';
import { atlasView, storeDepth, workspaceDepth, type AtlasView } from './preferences';
import { Progress } from './progress/Progress';
import { Changes } from './reader/Changes';
import { Lesson } from './reader/Lesson';
import { ReadState } from './ReadState';
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
}

export function Study({ workspace, workspaces, screen, go, onSwitch, onSelect, intent }: Props) {
  const [depth, setDepth] = useState(() => workspaceDepth(workspace.id));
  const [view, setView] = useState(atlasView);
  const [lesson, setLesson] = useState<{ id: number; question?: string; fromChange?: boolean }>();
  const [changeSelection, setChangeSelection] = useState<{ change: ChangeRef; intentId?: string }>();
  const linkedChange: ChangeRef | undefined = intent?.kind === 'commit' || intent?.kind === 'pr' ? { kind: intent.kind, ref: intent.ref } : undefined;
  const selected = changeSelection?.intentId === intent?.id ? changeSelection?.change ?? linkedChange : linkedChange;
  const readGraph = useCallback(() => call('graph:read', { workspaceId: workspace.id }), [workspace.id]);
  const { result, refresh } = useRead(readGraph);
  function changeDepth(next: Depth) {
    storeDepth(workspace.id, next);
    setDepth(next);
  }
  function changeView(next: AtlasView) {
    localStorage.setItem('delve.view', next);
    setView(next);
  }
  function openLesson(id: number, question?: string, fromChange = false) {
    setLesson({ id, question, fromChange });
    go('lesson');
  }
  async function startTopic() {
    const id = await call('reader:start-topic', { workspaceId: workspace.id });
    refresh();
    openLesson(id);
  }
  if (screen === 'baseline' && workspace.kind !== 'topic') {
    return <RepositoryBaseline workspace={workspace} depth={depth} onDepth={changeDepth} onBack={() => go('atlas')}
      onMapped={() => { refresh(); go('atlas'); }} />;
  }
  if (result.status !== 'ready') return <ReadState label="Knowledge graph" retry={refresh}
    message={result.status === 'error' ? result.message : undefined} />;

  const common = { workspace, graph: result.value, depth, view, onDepth: changeDepth, onBack: () => go('atlas'), onLesson: openLesson };
  return <div className={view}>
    {screen === 'atlas' && intent?.kind === 'proposed' && <ProposedContext intent={intent} graph={result.value} depth={depth} onLesson={openLesson} />}
    {screen === 'lesson' && lesson ? <Lesson {...common} conceptId={lesson.id} initialQuestion={lesson.question} onEvidence={refresh}
      onBackToChange={lesson.fromChange ? () => go('changes') : undefined} /> :
      screen === 'changes' ? <Changes {...common} selected={selected}
        onSelect={change => setChangeSelection({ change, intentId: intent?.id })}
        onFollowUp={id => openLesson(id, undefined, true)} onGenerated={refresh} /> :
      screen === 'progress' ? <Progress {...common} workspaces={workspaces} onSelect={onSelect} onEvidence={refresh} /> :
      <Atlas {...common} initialConceptId={lesson?.id} onView={changeView} onChanges={() => go('changes')}
        onStartTopic={startTopic} onProgress={() => go('progress')} onSwitch={onSwitch} onAdd={() => go('setup')}
        onFirstRun={() => go('first-run')} onMap={() => go('baseline')} />}
  </div>;
}
