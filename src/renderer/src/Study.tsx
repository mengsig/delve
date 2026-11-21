import { useCallback, useState } from 'react';
import type { Depth, Workspace } from '../../shared/domain';
import { call } from './api';
import { Atlas } from './atlas/Atlas';
import type { Screen } from './Header';
import { atlasView, storeDepth, workspaceDepth, type AtlasView } from './preferences';
import { Progress } from './progress/Progress';
import { Changes } from './reader/Changes';
import { Lesson } from './reader/Lesson';
import { ReadState } from './ReadState';
import { useRead } from './useRead';

interface Props {
  workspace: Workspace;
  workspaces: Workspace[];
  screen: Screen;
  go: (screen: Screen) => void;
  onSwitch: () => void;
  onSelect: (id: string) => void;
}

export function Study({ workspace, workspaces, screen, go, onSwitch, onSelect }: Props) {
  const [depth, setDepth] = useState(() => workspaceDepth(workspace.id));
  const [view, setView] = useState(atlasView);
  const [conceptId, setConceptId] = useState<number>();
  const readGraph = useCallback(() => call('graph:read', { workspaceId: workspace.id }), [workspace.id]);
  const { result, refresh } = useRead(readGraph);
  if (result.status !== 'ready') return <ReadState label="Knowledge graph" retry={refresh}
    message={result.status === 'error' ? result.message : undefined} />;

  function changeDepth(next: Depth) {
    storeDepth(workspace.id, next);
    setDepth(next);
  }
  function changeView(next: AtlasView) {
    localStorage.setItem('delve.view', next);
    setView(next);
  }
  function openLesson(id: number) {
    setConceptId(id);
    go('lesson');
  }
  const common = { workspace, graph: result.value, depth, view, onDepth: changeDepth, onBack: () => go('atlas'), onLesson: openLesson };
  return <div className={view}>
    {screen === 'lesson' && conceptId !== undefined ? <Lesson {...common} conceptId={conceptId} onEvidence={refresh} /> :
      screen === 'changes' ? <Changes {...common} /> :
      screen === 'progress' ? <Progress {...common} workspaces={workspaces} onSelect={onSelect} onEvidence={refresh} /> :
      <Atlas {...common} initialConceptId={conceptId} onView={changeView} onChanges={() => go('changes')}
        onProgress={() => go('progress')} onSwitch={onSwitch} onAdd={() => go('setup')} />}
  </div>;
}
