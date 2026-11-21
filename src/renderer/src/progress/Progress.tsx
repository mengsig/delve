import { useState } from 'react';
import type { Workspace } from '../../../shared/domain';
import type { WorkspaceGraph } from '../../../shared/graph';
import { call } from '../api';
import { ReadState } from '../ReadState';
import { useRead } from '../useRead';
import { Coverage } from './Coverage';
import { EvidenceLedger } from './EvidenceLedger';
import './progress.css';

const readCoverage = () => call('progress:read', null);

interface Props {
  workspace: Workspace;
  workspaces: Workspace[];
  graph: WorkspaceGraph;
  onSelect: (id: string) => void;
  onBack: () => void;
  onEvidence: () => void;
}

export function Progress({ workspace, graph, workspaces, onSelect, onBack, onEvidence }: Props) {
  const coverage = useRead(readCoverage);
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
