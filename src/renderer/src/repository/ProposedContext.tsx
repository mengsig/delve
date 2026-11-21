import type { Depth } from '../../../shared/domain';
import type { WorkspaceGraph } from '../../../shared/graph';
import type { LearnIntent } from '../../../shared/repository';

interface Props {
  intent: LearnIntent;
  graph: WorkspaceGraph;
  depth: Depth;
  onLesson: (id: number, question: string) => void;
}

export function ProposedContext({ intent, graph, depth, onLesson }: Props) {
  const suggestion = graph.suggestions?.[depth]?.conceptId;
  const concept = graph.concepts.find(item => item.id === suggestion) ?? graph.concepts[0];
  return <section className="card learn-intent" aria-label="Proposed change context">
    <h2>Proposed change</h2>
    <p className="repository-ref">Reference from the accepted link <code>{intent.ref}</code></p>
    <p>{concept ? 'Open a conversation to describe the proposal in your own words.' : 'Map this repository to discuss the proposal with your tutor.'}</p>
    {concept && <button onClick={() => onLesson(concept.id, 'I want to discuss this proposed change: ' + intent.ref)}>
      Discuss proposed change →
    </button>}
  </section>;
}
