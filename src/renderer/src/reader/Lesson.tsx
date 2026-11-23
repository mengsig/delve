import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { LessonAddress, ReaderLesson } from '../../../shared/reader';
import { EnvironmentActivity } from '../lab/EnvironmentActivity';
import { LatestInstrumentLink, LessonInstruments } from '../lab/Environment';
import { call } from '../api';
import { Icon } from '../Icon';
import { errorMessage, useRead } from '../useRead';
import { Conversation, LessonBlocks } from './Conversation';
import { FoundationActivity } from './FoundationActivity';
import { LessonHeading, LessonNotes } from './LessonNotes';
import { useLessonDraft } from './LessonDraft';
import { LessonRecovery, useOpenLesson } from './LessonStart';
import { LessonRail } from './Mastery';
import type { ReaderProps } from './ReaderHeader';
import { ResponseDock } from './ResponseDock';
import { Transcript } from './Transcript';
import { useTutor, type LessonTutor } from './Tutor';
import { lessonKey, useTutorJobs } from './TutorJobs';
import './reader.css';
import './fieldwork.css';

interface LessonProps extends ReaderProps {
  conceptId: number;
  onEvidence?: (lesson: ReaderLesson) => void;
  initialQuestion?: string;
  initialReview?: boolean;
  onBackToChange?: () => void;
}

function Thread({ body, tutor, scope, foundation }: { body: ReaderLesson; tutor: LessonTutor; scope: string; foundation?: { feedback?: string } }) {
  const openingLesson = useRef<HTMLElement>(null);
  useEffect(() => { if (foundation) openingLesson.current?.focus(); }, [foundation]);
  const job = tutor.job;
  const submitted = job?.phase === 'running' || job?.phase === 'cancelling' || job?.phase === 'failed' && job.code === 'TUTOR_INTERRUPTED' ? job : undefined;
  const intent = submitted?.request.intent;
  const selection = intent?.kind === 'answer' && (submitted?.submittedAnswer ??
    (typeof intent.answer === 'number' && body.mastery.activeCheck?.options?.[intent.answer]));
  const submittedText = intent?.kind === 'ask' ? intent.text : selection && intent?.kind === 'answer'
    ? [selection, intent.reasoning].filter(Boolean).join('\n') : '';
  return <>
    <header className="thread-heading"><span className="tutor-mark"><Icon name="layer" /></span>
      <div><b>Delve tutor</b><small>Lesson conversation</small></div><LatestInstrumentLink body={body} compact /><small className="local-status">● &nbsp;Saved locally</small>
    </header>
    <Transcript scope={scope} lastMessage={body.messages.at(-1)?.id} pendingTurn={submitted?.id}>
      {foundation?.feedback && <p role="status" className="reader-observation">{foundation.feedback}</p>}
      <LessonRecovery body={body} tutor={tutor} />
      {body.blocks.length > 0 && <section id="opening-lesson" tabIndex={-1} ref={openingLesson}><span className="message-author">Delve tutor</span>
        <LessonBlocks blocks={body.blocks} /></section>}
      {body.mastery.needsAdaptation && <section><strong>Saved question</strong><p>{body.mastery.activeCheck?.prompt}</p>
        {body.mastery.activeCheck?.options && <ol>{body.mastery.activeCheck.options.map((choice, i) => <li key={i}>{choice}</li>)}</ol>}</section>}
      <Conversation messages={body.messages} earlierMessages={body.earlierMessages} />
      {submittedText && <div className="reader-message reader-message-learner">
        <span className="message-author">{submitted?.phase === 'failed' ? 'You · awaiting feedback' : 'You · sending'}</span>
        <p>{submittedText}</p></div>}
    </Transcript>
  </>;
}

function useSkip(address: LessonAddress, body: ReaderLesson, commit: (lesson: ReaderLesson) => void) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  async function skip() {
    if (!body.mastery.revision || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try { commit(await call('reader:skip', { ...address, revision: body.mastery.revision })); }
    catch (cause) { setError('Could not skip the check. ' + errorMessage(cause)); }
    finally { locked.current = false; setBusy(false); }
  }
  return { skip, busy, error };
}

function Session({ props, initial, title, address, reload }: {
  props: LessonProps; initial: ReaderLesson; title: string; address: LessonAddress; reload: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [foundation, completeFoundation] = useState<{ feedback?: string }>();
  const scope = lessonKey(address);
  const { jobs, dismiss } = useTutorJobs();
  const job = jobs.get(scope);
  const submitted = job?.phase === 'failed' && job.code === 'TUTOR_INTERRUPTED' ? job.request.intent : undefined;
  const { draft, change } = useLessonDraft(scope, body.mastery, props.initialQuestion, submitted);
  function commit(next: ReaderLesson) { setBody(next); props.onEvidence?.(next); }
  const tutor = useTutor(address, title, props.graph.demo, (lesson, intent) => {
    if (intent.kind === 'ask' && draft.question.trim() === intent.text) change({ question: '' });
    commit(lesson);
  });
  const opening = useOpenLesson(body, tutor, props.initialReview && !body.foundation);
  const skip = useSkip(address, body, commit);
  async function refresh() {
    if (tutor.job?.phase === 'failed') await dismiss(tutor.job);
    reload();
  }
  const activity = useContext(EnvironmentActivity);
  const lessonActivity = activity && { ...activity, onUse: (key: string, name: string) => {
    if (draft.mode !== 'ask') change({ mode: 'ask' });
    activity.onUse(key, name);
  } };
  if (body.foundation) return <div className="field-lesson">
    <LessonHeading props={props} title={title} />
    <FoundationActivity address={address} initial={body.foundation} onComplete={async feedback => {
      commit(await call('reader:lesson', address));
      completeFoundation({ feedback });
    }} />
  </div>;
  return <div className="field-lesson"><EnvironmentActivity.Provider value={lessonActivity}>
    <LessonInstruments address={address} body={body} onLesson={commit}>
      <LessonHeading props={props} title={title}><LessonNotes props={props} body={body} tutor={tutor} busy={skip.busy || tutor.pending}
        skip={skip.skip} review={() => body.mastery.revision && tutor.prepare({ kind: 'review', revision: body.mastery.revision })} /></LessonHeading>
      <div className="lesson-columns"><article className="reader-thread" aria-label="Lesson and conversation">
        <Thread body={body} tutor={tutor} scope={scope} foundation={foundation} />
        {skip.error && <p role="alert">{skip.error}</p>}
        <ResponseDock {...{ props, body, title, tutor, draft, change, opening }} reload={refresh} busy={skip.busy} />
      </article>
      <LessonRail props={props} title={title} mastery={body.mastery} /></div>
    </LessonInstruments></EnvironmentActivity.Provider>
  </div>;
}

function Reader({ props, title, reload }: { props: LessonProps; title: string; reload: () => void }) {
  const { workspace: { id: workspaceId }, conceptId, depth } = props;
  const read = useCallback(() => call('reader:lesson', { workspaceId, conceptId, depth }), [workspaceId, conceptId, depth]);
  const { result, refresh } = useRead(read);
  if (result.status === 'ready') return <Session props={props} title={title} initial={result.value}
    address={{ workspaceId, conceptId, depth }} reload={reload} />;
  return <div className="field-lesson"><LessonHeading props={props} title={title} />
    {result.status === 'error' ? <p role="alert">{result.message} <button onClick={refresh}>Retry loading lesson</button></p> :
      <p role="status">Loading lesson…</p>}</div>;
}

export function Lesson(props: LessonProps) {
  const [version, update] = useState(0);
  const concept = props.graph.concepts.find(node => node.id === props.conceptId);
  if (!concept || props.graph.workspaceId !== props.workspace.id) return <>
    <button className="back" onClick={props.onBack}>{props.backLabel ?? '← Back to atlas'}</button><p role="alert">This workspace does not contain the selected concept.</p>
  </>;
  return <Reader key={[props.workspace.id, props.conceptId, props.depth, props.graph.snapshot, version].join('/')} props={props} title={concept.title} reload={() => update(value => value + 1)} />;
}
