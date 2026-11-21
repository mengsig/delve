import { useEffect, useState } from 'react';
import type { GraphConcept } from '../../../shared/graph';
import type { LessonAddress, ReaderLesson } from '../../../shared/reader';
import { call } from '../api';
import { Composer, Conversation, LessonBlocks } from './Conversation';
import { ReaderHeader, type ReaderProps } from './ReaderHeader';
import { TutorControls, useTutor } from './Tutor';
import './reader.css';

interface LessonProps extends ReaderProps {
  conceptId: number;
  onEvidence?: () => void;
}

function FieldNotes({ props, body }: { props: LessonProps; body?: ReaderLesson }) {
  const { depth, conceptId, graph, view, workspace, onBack } = props;
  const evidence = graph.evidence.find(e => e.depth === depth && e.conceptId === conceptId);
  const recommendation = body?.messages.findLast(m => m.recommendation)?.recommendation;
  const target = recommendation?.targetId && graph.concepts.find(c => c.id === recommendation.targetId);
  const known = evidence?.status === 'demonstrated';
  const source = body ? body.source : graph.snapshot;
  return <aside className="card">
    <span className="eyebrow">{view === 'folio' ? 'Notebook / evidence margin' : 'Field notes / this concept'}</span>
    <h3>{known ? 'Prior knowledge' : 'A new connection'}</h3>
    <p>{known ? `Demonstrated at ${depth} depth${evidence.workspaceName ? ' in ' + evidence.workspaceName : ''}. Review by choice.`
      : evidence ? `Your evidence at ${depth} depth is marked ${evidence.status}.` : `No evidence recorded at ${depth} depth.`}</p>
    <div className="impact"><span className="plate">Source {workspace.kind === 'topic' ? 'study' : 'snapshot'}</span>
      <div className="mono mini">{source ?? 'No source recorded'}{graph.demo && ' · demo'}</div></div>
    {body?.blocks.some(b => b.type === 'environment') && !body.reused && <div className="impact"><a href="#instrument">Jump to instrument ↓</a></div>}
    {body?.blocks.some(b => b.type === 'check') && !body.reused && <div className="impact"><a href="#checkpoint">Jump to the check ↓</a></div>}
    {recommendation && <div className="impact"><span className="plate">Suggested next step</span><h4>{recommendation.action}</h4>
      <p>{recommendation.reason}</p>{target && <button onClick={() => props.onLesson(target.id)}>Open {target.title} →</button>}</div>}
    <div className="impact"><button onClick={onBack}>See my atlas →</button></div>
  </aside>;
}

function LessonThread({ body, address, props, onLesson }: {
  body: ReaderLesson; address: LessonAddress; props: LessonProps; onLesson: (lesson: ReaderLesson) => void;
}) {
  const [draft, setDraft] = useState('');
  const [review, setReview] = useState(!body.reused);
  const tutor = useTutor(address, props.graph.demo, (lesson, intent) => {
    onLesson(lesson);
    if (intent.kind === 'ask') setDraft(current => current.trim() === intent.text ? '' : current);
    if (intent.kind === 'answer' || lesson.messages.at(-1)?.recommendation) props.onEvidence?.();
  });
  const answer = (value: number | string) => {
    if (body.revision) void tutor.prepare({ kind: 'answer', revision: body.revision, answer: value });
  };
  return <article className="sheet reader-thread" aria-label="Lesson and conversation">
    <TutorControls tutor={tutor} demo={props.graph.demo} canStart={!body.reused && !body.blocks.length && !body.invalidLatest} />
    {body.invalidLatest && <div className="reader-notice" role="status">
      <p>{body.revision ? 'The newest lesson is invalid. Showing the last valid version.' : 'The stored lesson could not be displayed.'}</p>
      <button disabled={tutor.pending} onClick={() => void tutor.prepare({ kind: 'teach' })}>Retry lesson generation</button>
    </div>}
    {body.reused && !review && <section className="chapter">
      <h3>You know this connection</h3><p>You can build on your evidence at this depth or ask for another example.</p>
      {body.blocks.length > 0 && <button onClick={() => setReview(true)}>Review opening lesson</button>}
    </section>}
    {review && body.blocks.length > 0 && <section id="opening-lesson">
      <span className="eyebrow reader-author">{props.graph.demo ? 'Demo tutor' : 'Tutor'} / Field lesson</span>
      <LessonBlocks key={body.revision} blocks={body.blocks} pending={tutor.pending || !body.revision} onAnswer={answer} />
    </section>}
    <Conversation messages={body.messages} earlierMessages={body.earlierMessages} />
    <Composer tutor={tutor} draft={draft} setDraft={setDraft} />
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
      result => { if (current) setBody(result); },
      reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { current = false; };
  }, [workspaceId, conceptId, depth, attempt]);
  return <>
    <ReaderHeader {...props} label={`Field lesson / ${workspace.name} / ${view === 'folio' ? 'Folio' : 'Contour'}`}
      title={concept.title} summary={concept.summary} />
    <div className="reader reader-layout">
      {error ? <article className="sheet"><p role="alert">{error}</p><button onClick={retry}>Retry loading lesson</button></article>
        : body ? <LessonThread body={body} props={props} address={{ workspaceId, conceptId, depth }} onLesson={setBody} />
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
