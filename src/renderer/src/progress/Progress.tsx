import { useState } from 'react';
import { DEPTHS, type Depth, type Workspace } from '../../../shared/domain';
import type { WorkspaceGraph } from '../../../shared/graph';
import { call } from '../api';
import { useBackgroundTutorCompletion } from '../reader/TutorJobs';
import { ReadState } from '../ReadState';
import { useRead } from '../useRead';
import { Coverage } from './Coverage';
import { EvidenceLedger } from './EvidenceLedger';
import type { LearningProgress } from './model';
import { ConceptMeter, WorkspaceMeter } from './ProgressMeters';
import './progress.css';

const readCoverage = () => call('progress:read', null);

interface Props {
  workspace: Workspace;
  workspaces: Workspace[];
  graph: WorkspaceGraph;
  depth: Depth;
  progress?: LearningProgress;
  currentId?: number;
  onDepth: (depth: Depth) => void;
  onSelect: (id: string) => void;
  onBack: () => void;
  onEvidence: () => void;
}

function PathCoverage({ progress, currentId, depth, onDepth }: Pick<Props, 'progress' | 'currentId' | 'depth' | 'onDepth'>) {
  const current = currentId === undefined ? undefined : progress?.byId.get(currentId);
  const other = progress?.concepts.filter(concept => concept.onAtlas && concept.id !== currentId) ?? [];
  return <section className="sheet progress-path" aria-label="Workspace learning path">
    <div className="progress-path-heading">
      <h2>Learning path</h2>
      <label>Reading depth <select value={depth} onChange={event => {
        const next = DEPTHS.find(item => item === event.target.value);
        if (next) onDepth(next);
      }}>
        {DEPTHS.map(item => <option key={item} value={item}>{item}</option>)}
      </select></label>
    </div>
    <WorkspaceMeter progress={progress} />
    {progress?.available && <>
      {current && <div className="progress-current"><ConceptMeter concept={current} current /></div>}
      {other.length > 0 && <ul className="progress-concepts" aria-label="Concept progress" tabIndex={0}>
        {other.map(concept => <li key={concept.id}><ConceptMeter concept={concept} /></li>)}
      </ul>}
      {!current && !other.length && <p>No concepts in this learning path yet.</p>}
    </>}
  </section>;
}

export function Progress({ workspace, graph, depth, progress, currentId, onDepth, workspaces, onSelect, onBack, onEvidence }: Props) {
  const coverage = useRead(readCoverage);
  useBackgroundTutorCompletion(coverage.refresh);
  const [notice, setNotice] = useState('');
  function evidenceChanged() {
    setNotice('Learning record reset. Coverage is updating.');
    onEvidence();
    coverage.refresh();
  }
  return <>
    <button className="back" onClick={onBack}>← Back to atlas</button>
    <div className="intro">
      <span className="eyebrow">Profile / Local learner</span>
      <h1>Your field record.</h1>
      <p>How much of each terrain have you explored? Progress is tracked separately at each depth. Opening a lesson does not count.</p>
    </div>
    <PathCoverage {...{ progress, currentId, depth, onDepth }} />
    {coverage.result.status === 'ready'
      ? <Coverage workspaces={workspaces} rows={coverage.result.value} activeId={workspace.id} onSelect={onSelect} />
      : <ReadState label="Workspace coverage" retry={coverage.refresh}
        message={coverage.result.status === 'error' ? coverage.result.message : undefined} />}
    <div className="grid2 progress-notes">
      <EvidenceLedger graph={graph} workspaceName={workspace.name} onSelect={onSelect} onReset={evidenceChanged} onExplore={onBack} />
      <section className="note">
        <span className="eyebrow">Privacy / Local record</span>
        <h3>Your learning record stays here.</h3>
        <p>Delve stores this field record on your device. Choose a workspace above to inspect your progress or reset a record at a single depth.</p>
        <p>Shared records show which workspace they came from. Resetting one also updates coverage wherever that concept is shared.</p>
        <p role="status">{notice}</p>
      </section>
    </div>
  </>;
}
