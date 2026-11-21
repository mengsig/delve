import { useRef } from 'react';
import { statusText, type AtlasConcept, type AtlasModel } from './model';

interface Selection {
  selected: AtlasConcept;
  onSelect: (id: number) => void;
}

interface FolioProps extends Selection {
  model: AtlasModel;
  workspaceId: string;
  changedId?: number;
  recommendedId?: number;
}

const headings = ['Foundations', 'Mechanisms', 'Applications'];

export function Folio({ model, selected, changedId, recommendedId, workspaceId, onSelect }: FolioProps) {
  const groups = [model.layers[0] ?? [], model.layers[1] ?? [], model.layers.slice(2).flat()];
  return <section className="ledger" aria-label="Folio dependency ledger">
    <span className="eyebrow">Folio / dependency ledger</span><h3>From foundations to practice</h3>
    <div className="stages">{groups.map((concepts, i) => concepts.length > 0 && <section className="stage" key={i}>
      <h4 className="plate">{headings[i]}</h4>
      <ul>{concepts.map(concept => <li key={concept.id}>
        <button aria-pressed={selected.id === concept.id} onClick={() => onSelect(concept.id)}>
          <strong>{concept.title}</strong>
          <span className="sub">{statusText(concept, workspaceId, concept.id === changedId)}{concept.id === recommendedId && ' · Next'}</span>
          {concept.prerequisites.length > 0 && <span className="atlas-folio-prior">
            Requires {concept.prerequisites.map(prior => prior.title).join(' + ')}
          </span>}
        </button>
      </li>)}</ul>
    </section>)}</div>
  </section>;
}

function RelatedConcepts({ label, concepts, onSelect }: {
  label: string; concepts: AtlasConcept[]; onSelect: Selection['onSelect'];
}) {
  if (!concepts.length) return null;
  return <span className="sub">{label}{' '}
    {concepts.map((concept, index) => <span key={concept.id}>{index > 0 && ' + '}
      <button className="atlas-related" onClick={() => onSelect(concept.id)}>{concept.title}</button>
    </span>)}
  </span>;
}

interface InspectorProps extends Selection {
  status: string;
  onLesson: (id: number) => void;
}

export function Inspector({ selected, status, onLesson, onSelect }: InspectorProps) {
  const title = useRef<HTMLElement>(null);
  function selectRelated(id: number) {
    title.current?.focus({ preventScroll: true });
    onSelect(id);
  }
  return <section className="inspector" aria-label="Selected concept">
    <div>
      <span className="plate">Selected · {status}</span>
      <strong aria-live="polite" ref={title} tabIndex={-1}>{selected.title}</strong>
      <div className="atlas-relations">
        {!selected.prerequisites.length && <span className="sub">Foundation · no prerequisites</span>}
        <RelatedConcepts label="Builds on" concepts={selected.prerequisites} onSelect={selectRelated} />
        <RelatedConcepts label="Leads to" concepts={selected.dependents} onSelect={selectRelated} />
      </div>
    </div>
    <button className="primary-btn" onClick={() => onLesson(selected.id)}>Open lesson →</button>
  </section>;
}
