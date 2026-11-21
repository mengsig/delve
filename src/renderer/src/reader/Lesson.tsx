import { useEffect, useState } from 'react';
import type { GraphConcept } from '../../../shared/graph';
import type { LessonAddress, ReaderLesson } from '../../../shared/reader';
import { call } from '../api';
import { Check, TeachingBlock } from './Blocks';
import { Conversation } from './Conversation';
import { ReaderHeader, type ReaderProps } from './ReaderHeader';
import './reader.css';

interface LessonProps extends ReaderProps {
  conceptId: number;
  onEvidence?: () => void;
}

function FieldNotes({ props, body }: { props: LessonProps; body?: ReaderLesson }) {
  const { depth, conceptId, graph, view, workspace, onBack } = props;
  const evidence = graph.evidence.find(e => e.depth === depth && e.conceptId === conceptId);
  const known = evidence?.status === 'demonstrated';
  const source = body ? body.source : graph.snapshot;
  return <aside className="card">
    <span className="eyebrow">{view === 'folio' ? 'Notebook / evidence margin' : 'Field notes / this concept'}</span>
    <h3>{known ? 'Prior knowledge' : 'A new connection'}</h3>
    <p>{known ? `Demonstrated at ${depth} depth${evidence.workspaceName ? ' in ' + evidence.workspaceName : ''}. Review by choice.`
      : evidence ? `Your evidence at ${depth} depth is marked ${evidence.status}.` : `No evidence recorded at ${depth} depth.`}</p>
    <div className="impact"><span className="plate">Source {workspace.kind === 'topic' ? 'study' : 'snapshot'}</span>
      <div className="mono mini">{source ?? 'No source recorded'}{graph.demo && ' · demo'}</div></div>
    {body && !body.blocks.some(b => b.type === 'environment') && <div className="impact">
      <span className="plate">Environment</span><p>No environment in this lesson.</p>
    </div>}
    {body?.blocks.some(b => b.type === 'check') && <div className="impact"><a href="#checkpoint">Jump to the check ↓</a></div>}
    {body && <div className="impact"><a href="#reader-question">Ask a question ↓</a></div>}
    <div className="impact"><button onClick={onBack}>See my atlas →</button></div>
  </aside>;
}

function LessonThread({ body, address, props, retry }: { body: ReaderLesson; address: LessonAddress; props: LessonProps; retry: () => void }) {
  return <article className="sheet reader-thread" aria-label="Lesson and conversation">
    {body.invalidLatest && <div className="reader-notice" role="status">
      <p>{body.revision ? 'The newest lesson is invalid. Showing the last valid version.' : 'The stored lesson could not be displayed.'}</p>
      <button onClick={retry}>Retry loading lesson</button>
    </div>}
    {body.blocks.length > 0 ? <div>
      <div className="reader-author"><span className="eyebrow">{props.graph.demo ? 'Demo tutor' : 'Tutor'} / Field lesson</span></div>
      {body.blocks.map((block, i) => block.type === 'check'
        ? body.revision && <Check key={i} block={block} address={address} revision={body.revision} onEvidence={props.onEvidence} />
        : <TeachingBlock key={i} block={block} />)}
    </div> : !body.invalidLatest && <section className="chapter"><h3>No saved lesson at this depth</h3>
      <p>You can keep questions about this concept in the conversation below.</p></section>}
    <Conversation address={address} demo={props.graph.demo} messages={body.messages} earlierMessages={body.earlierMessages} />
  </article>;
}

function Reader({ props, concept }: { props: LessonProps; concept: GraphConcept }) {
  const { workspace, conceptId, depth, view } = props;
  const workspaceId = workspace.id;
  const [body, setBody] = useState<ReaderLesson>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const retry = () => { setError(''); setAttempt(n => n + 1); };
  useEffect(() => {
    let current = true;
    call('reader:lesson', { workspaceId, conceptId, depth }).then(
      body => { if (current) setBody(body); },
      reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { current = false; };
  }, [workspaceId, conceptId, depth, attempt]);
  return <>
    <ReaderHeader {...props} label={`Field lesson / ${workspace.name} / ${view === 'folio' ? 'Folio' : 'Contour'}`}
      title={concept.title} summary={concept.summary} />
    <div className="reader reader-layout">
      {error ? <article className="sheet"><p role="alert">{error}</p><button onClick={retry}>Retry loading lesson</button></article>
        : body ? <LessonThread body={body} props={props} address={{ workspaceId, conceptId, depth }} retry={retry} />
        : <article className="sheet" role="status">Loading lesson…</article>}
      <FieldNotes props={props} body={body} />
    </div>
  </>;
}

export function Lesson(props: LessonProps) {
  const concept = props.graph.concepts.find(node => node.id === props.conceptId);
  if (!concept || props.graph.workspaceId !== props.workspace.id) return <>
    <button className="back" onClick={props.onBack}>← Back to atlas</button><p role="alert">This workspace does not contain the selected concept.</p>
  </>;
  return <Reader key={[props.workspace.id, props.conceptId, props.depth, props.graph.snapshot].join('/')} props={props} concept={concept} />;
}
