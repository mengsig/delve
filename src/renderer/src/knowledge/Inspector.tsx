import { useState } from 'react';
import type { Depth } from '../../../shared/domain';
import type { GlobalKnowledgeGraph, KnowledgeConcept } from '../../../shared/knowledge';
import { call } from '../api';
import { Meter } from '../design/Meter';
import { Icon } from '../Icon';
import { LessonStart } from '../reader/LessonStart';
import { useDetectedProvider, type useProviderDetection } from '../SetupProvider';
import { errorMessage } from '../useRead';
import { Connections } from './Connections';
import { stateLabels, type Place } from './areas';
import type { KnowledgeActions } from './Knowledge';

interface Props {
  graph: GlobalKnowledgeGraph;
  concept: KnowledgeConcept;
  place: Place;
  depth: Depth;
  suggested: boolean;
  demo: boolean;
  detection: ReturnType<typeof useProviderDetection>;
  details: boolean;
  setDetails: (open: boolean) => void;
  select: (id: number) => void;
  focused: boolean;
  focus: () => void;
  refresh: () => void;
  onOpen: KnowledgeActions['onOpen'];
}

export function AreaProgress({ name, mastered, total, available }: { name: string; mastered: number; total: number; available: boolean }) {
  return <header className="knowledge-area-progress">
    <span className="plate">Area progress</span><h2>{name}</h2>
    <Meter label="Concepts mastered" value={mastered} max={total} tone="mastered" hatched={!available}
      detail={available ? `${mastered} of ${total}` : 'Progress unavailable'} />
  </header>;
}

export function Inspector(props: Props) {
  const { concept, graph, place, depth, suggested, details, setDetails, select, onOpen } = props;
  const { area, progress, state } = place;
  const open = (target: 'lesson' | 'review' | 'atlas') => onOpen(area.workspaceId, concept.id, target, depth);
  const learned = progress.prerequisites.map(id => area.progress.byId.get(id)?.title).filter(name => name !== undefined);
  const reason = progress.unmet.length ? 'Learn ' + progress.unmet.map(prior => prior.title).join(' and ') + ' first.'
    : learned.length ? 'You already understand ' + learned.join(' and ') + '.' : 'You can begin here without a previous lesson.';
  return <>
    <div className="knowledge-inspector-scroll">
      <div className="knowledge-status"><Icon name={state === 'mastered' ? 'check' : state === 'locked' ? 'lock' : 'route'} />
        {suggested ? 'Suggested next' : stateLabels[state]}</div>
      <h3>{concept.title}</h3>{concept.summary && <p>{concept.summary}</p>}
      <div className="knowledge-reason"><h4>{state === 'mastered' ? 'What you know' : state === 'locked' ? 'What comes first?' : 'Why learn this now?'}</h4>
        <p>{state === 'mastered' ? 'You demonstrated this concept at ' + depth + ' depth.' : reason}</p></div>
      <button className="knowledge-disclosure" aria-expanded={details} onClick={() => setDetails(!details)}>
        <Icon name="knowledge" />Connections &amp; details <span aria-hidden="true">{details ? '−' : '+'}</span></button>
      {details && <div className="knowledge-more">
        <p>{concept.bridge && 'Shared concept · '}Used in {concept.memberships.map(w => w.workspaceName).join(', ')}.</p>
        {concept.masteredDepth && <p>Deepest verified depth: {concept.masteredDepth}.</p>}
        {concept.masteryState === 'skipped' && <p>Practice was paused in a previous lesson.</p>}
        <div className="knowledge-actions"><button onClick={props.focus}>{props.focused ? 'Show all connections' : 'Focus neighbourhood'}</button>
          <button onClick={() => open('atlas')}>Show in workspace Atlas</button>
          {concept.masteredDepth && <button onClick={() => onOpen(area.workspaceId, concept.id, 'review', concept.masteredDepth!)}>Review</button>}</div>
        <Relationships graph={graph} concept={concept} select={select} refresh={props.refresh} demo={props.demo} />
      </div>}
    </div>
    <footer className="knowledge-start">
      {state === 'mastered' || state === 'locked' || !progress.onAtlas
        ? <button className="primary-btn" onClick={() => open('lesson')}>{state === 'locked' ? 'Explore this lesson' : 'Open lesson'} <span aria-hidden="true">→</span></button>
        : <PreparedLesson workspaceId={area.workspaceId} concept={concept} demo={props.demo} detection={props.detection} depth={depth} open={() => open('lesson')} />}
    </footer>
  </>;
}

function PreparedLesson({ concept, workspaceId, depth, demo, detection, open }: {
  detection: Props['detection']; concept: KnowledgeConcept; workspaceId: string; depth: Depth; demo: boolean; open: () => void;
}) {
  const { provider, cli } = useDetectedProvider(detection.statuses);
  return <>{!demo && detection.error && <div role="alert">{detection.error} <button onClick={detection.retry}>Check tutor again</button></div>}
    <LessonStart workspaceId={workspaceId} conceptId={concept.id} depth={depth} provider={demo ? 'demo' : provider}
    signedIn={demo || (detection.checking ? undefined : cli?.state === 'signed-in')} title={concept.title} open={open} /></>;
}

function Relationships({ graph, concept, select, refresh, demo }: Pick<Props, 'graph' | 'concept' | 'select' | 'refresh' | 'demo'>) {
  const [failure, setFailure] = useState('');
  const links = graph.links.filter(l => l.fromConceptId === concept.id || l.toConceptId === concept.id);
  const titles = new Map(graph.concepts.map(c => [c.id, c.title]));
  const names = (ids: number[]) => ids.map(id =>
    <button key={id} className="knowledge-link" onClick={() => select(id)}>{titles.get(id)}</button>);
  const before = names(graph.edges.filter(e => e.conceptId === concept.id).map(e => e.prerequisiteId));
  const after = names(graph.edges.filter(e => e.prerequisiteId === concept.id).map(e => e.conceptId));
  async function remove(id: number) {
    try { await call('knowledge:remove-link', { id }); refresh(); }
    catch (error) { setFailure(errorMessage(error)); }
  }
  return <>
    <h4>Builds on</h4><div className="knowledge-related">{before.length ? before : 'No prerequisites.'}</div>
    <h4>Prepares you for</h4><div className="knowledge-related">{after.length ? after : 'No later concepts mapped yet.'}</div>
    <h4>Transfers</h4>{links.length ? <ul>{links.map(link => {
      const other = link.fromConceptId === concept.id ? link.toConceptId : link.fromConceptId;
      return <li key={link.id}>{names([other])}<p>{link.reason}</p><small>Proposed by {link.provider} · {link.model}</small>
        {!demo && <button onClick={() => void remove(link.id)}>Remove link</button>}</li>;
    })}</ul> : <p>No transfer links yet.</p>}
    {failure && <p role="alert">{failure}</p>}
    {!demo && <Connections key={concept.id} concept={concept} refresh={refresh} />}
  </>;
}
