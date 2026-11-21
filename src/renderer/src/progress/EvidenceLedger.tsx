import { useState } from 'react';
import type { GraphConcept, GraphEvidence, WorkspaceGraph } from '../../../shared/graph';
import { call } from '../api';
import { errorMessage } from '../useRead';

interface LedgerProps {
  graph: WorkspaceGraph;
  workspaceName: string;
  onSelect: (workspaceId: string) => void;
  onReset: () => void;
}

function EvidenceEntry({ concept, evidence, workspaceId, onSelect, onReset }: {
  concept: GraphConcept; evidence: GraphEvidence; workspaceId: string;
  onSelect: LedgerProps['onSelect']; onReset: LedgerProps['onReset'];
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const origin = evidence.workspaceId;
  async function reset() {
    setPending(true);
    setError('');
    try {
      await call('evidence:reset', { workspaceId, conceptId: concept.id, depth: evidence.depth });
      onReset();
      setConfirming(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  return <li className="impact evidence-entry">
    <div><strong>{concept.title}</strong><span className="tag">{evidence.depth} · {evidence.status}</span></div>
    {evidence.note && <p>{evidence.note}</p>}
    <small>{[evidence.source, evidence.workspaceName ?? 'Local evidence', `revision ${evidence.revision}`].join(' · ')}</small>
    {origin && origin !== workspaceId ?
      <button className="back" onClick={() => onSelect(origin)}>Manage in {evidence.workspaceName ?? 'source workspace'} ↗</button> :
      confirming ? <div className="confirm-reset" role="group" aria-label={`Confirm reset of ${concept.title}`}>
        <p>Remove {evidence.depth}-depth evidence for {concept.title}{concept.portable ? ' in every atlas that shares it' : ' in this workspace'}?</p>
        <div className="actions">
          <button onClick={reset} disabled={pending}>{pending ? 'Resetting…' : 'Confirm reset'}</button>
          <button onClick={() => setConfirming(false)} disabled={pending}>Keep evidence</button>
        </div>
      </div> : <button className="back" onClick={() => setConfirming(true)}>Reset evidence</button>}
    {error && <p role="alert">{error}</p>}
  </li>;
}

export function EvidenceLedger({ graph, workspaceName, onSelect, onReset }: LedgerProps) {
  const concepts = new Map(graph.concepts.map(concept => [concept.id, concept]));
  return <section className="note">
    <span className="eyebrow">Evidence ledger / {workspaceName}</span><h3>Knowledge travels with you.</h3>
    <p>Each record belongs to one concept at one depth. Portable concepts carry their evidence into every workspace that uses them.</p>
    {graph.evidence.length ? <details><summary>Inspect {graph.evidence.length} evidence records</summary>
      <ul className="evidence-list">{graph.evidence.map(evidence => {
      const concept = concepts.get(evidence.conceptId);
      if (!concept) throw new Error('Evidence refers to a concept outside this atlas.');
      return <EvidenceEntry key={`${concept.id}:${evidence.depth}`} concept={concept} evidence={evidence}
        workspaceId={graph.workspaceId} onReset={onReset} onSelect={onSelect} />;
    })}</ul></details> : <p className="impact">No evidence recorded for this workspace yet.</p>}
  </section>;
}
