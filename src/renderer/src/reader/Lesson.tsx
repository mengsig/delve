import { useEffect, useLayoutEffect, useState } from 'react';
import type { GraphConcept } from '../../../shared/graph';
import type { LessonAddress, ReaderLesson } from '../../../shared/reader';
import { LessonInstruments } from '../lab/Environment';
import { call } from '../api';
import { Composer, Conversation, LessonBlocks } from './Conversation';
import { ReaderHeader, type ReaderProps } from './ReaderHeader';
import { TutorControls, TutorTurnStatus, useTutor } from './Tutor';
import { lessonKey, useTutorJobs } from './TutorJobs';
import { LessonProgress, MasteryFlow } from './Mastery';
import './reader.css';

interface LessonProps extends ReaderProps {
  conceptId: number;
  onEvidence?: () => void;
  initialQuestion?: string;
  onBackToChange?: () => void;
}

function FieldNotes({ props, body }: { props: LessonProps; body?: ReaderLesson }) {
  const { depth, conceptId, graph, view, workspace, onBack } = props;
  const evidence = graph.evidence.find(e => e.depth === depth && e.conceptId === conceptId);
  const known = evidence?.status === 'demonstrated';
  const source = body ? body.source : graph.snapshot;
  return <aside className="card">
    <span className="eyebrow">{view === 'folio' ? 'Notebook / this concept' : 'Field notes / this concept'}</span>
    <h3>{known ? 'Prior knowledge' : 'A new connection'}</h3>
    <p>{known ? `Understood at ${depth} depth${evidence.workspaceName ? ' in ' + evidence.workspaceName : ''}.`
      : `Not yet marked understood at ${depth} depth.`}</p>
    <div className="impact"><span className="plate">Source {workspace.kind === 'topic' ? 'study' : 'snapshot'}</span>
      <div className="mono mini">{source ?? 'No source recorded'}{graph.demo && ' · demo'}</div></div>
    {body?.blocks.some(b => b.type === 'environment') && !body.reused && <div className="impact"><a href="#instrument">Jump to instrument ↓</a></div>}
    {body?.mastery.activeCheck && <div className="impact"><a href="#checkpoint">Jump to the check ↓</a></div>}
    <div className="impact"><button onClick={onBack}>See my atlas →</button></div>
  </aside>;
}

function useLessonPosition(address: LessonAddress) {
  const { positions } = useTutorJobs();
  const key = lessonKey(address);
  useLayoutEffect(() => {
    const position = positions.current.get(key);
    if (position) window.scrollTo({ top: position, behavior: 'instant' });
    function remember() {
      positions.current.set(key, window.scrollY);
    }
    window.addEventListener('scroll', remember, { passive: true });
    return () => window.removeEventListener('scroll', remember);
  }, [key, positions]);
}

function LessonThread({ body, address, props, onLesson }: {
  body: ReaderLesson; address: LessonAddress; props: LessonProps; onLesson: (lesson: ReaderLesson) => void;
}) {
  const [draft, setDraft] = useState(props.initialQuestion ?? '');
  const [animate] = useState(!body.revision);
  useLessonPosition(address);
  const title = props.graph.concepts.find(concept => concept.id === address.conceptId)?.title ?? props.workspace.name;
  const tutor = useTutor(address, title, props.graph.demo, (lesson, intent) => {
    onLesson(lesson);
    if (intent.kind === 'ask') setDraft(current => current.trim() === intent.text ? '' : current);
    if (intent.kind === 'answer' || lesson.messages.at(-1)?.recommendation) props.onEvidence?.();
  });
  return <article className="sheet reader-thread" aria-label="Lesson and conversation">
    <LessonInstruments address={address} body={body} onLesson={lesson => { onLesson(lesson); props.onEvidence?.(); }}>
    <div className="reader-scroll">
    <LessonProgress props={props} mastery={body.mastery} />
    <TutorControls tutor={tutor} demo={props.graph.demo} canStart={!tutor.running && !body.reused && !body.blocks.length && !body.invalidLatest} />
    {body.invalidLatest && <div className="reader-notice" role="status">
      <p>{body.revision ? 'The newest lesson is invalid. Showing the last valid version.' : 'The stored lesson could not be displayed.'}</p>
      <div className="actions">
        <button disabled={tutor.pending} onClick={() => tutor.prepare({ kind: 'teach' })}>Retry lesson generation</button>
        {!props.graph.demo && <button disabled={tutor.pending}
          onClick={() => tutor.prepare({ kind: 'teach' }, true)}>Preview lesson request</button>}
      </div>
    </div>}
    {body.blocks.length > 0 && <section id="opening-lesson">
      <span className="eyebrow reader-author">{props.graph.demo ? 'Demo tutor' : 'Tutor'} / Field lesson</span>
      <LessonBlocks key={body.revision} blocks={body.blocks.filter(block => block.type !== 'check')} animate={animate} />
    </section>}
    <Conversation messages={body.messages} earlierMessages={body.earlierMessages} />
    <MasteryFlow body={body} address={address} props={props} tutor={tutor} onLesson={lesson => { onLesson(lesson); props.onEvidence?.(); }} />
    </div>
    <TutorTurnStatus tutor={tutor} onBackground={props.onBackToChange ?? props.onBack} />
    <Composer tutor={tutor} draft={draft} setDraft={setDraft} focusOnOpen={Boolean(props.onBackToChange || props.initialQuestion)} />
    </LessonInstruments>
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
      title={concept.title} summary={concept.summary} onBack={props.onBackToChange ?? props.onBack}
      backLabel={props.onBackToChange ? '← Back to change brief' : undefined} />
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
