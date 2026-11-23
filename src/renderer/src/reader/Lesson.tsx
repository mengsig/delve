import { useCallback, useContext, useRef, useState } from 'react';
import type { LessonAddress, ReaderLesson } from '../../../shared/reader';
import { EnvironmentActivity } from '../lab/EnvironmentActivity';
import { LatestInstrumentLink, LessonInstruments } from '../lab/Environment';
import { call } from '../api';
import { Icon } from '../Icon';
import { errorMessage, useRead } from '../useRead';
import { Conversation, LessonBlocks } from './Conversation';
import { LessonHeading, LessonNotes } from './LessonNotes';
import { useLessonDraft } from './LessonDraft';
import { useOpenLesson } from './LessonStart';
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

function Thread({ body, tutor, scope }: { body: ReaderLesson; tutor: LessonTutor; scope: string }) {
  const pending = tutor.job?.phase === 'running' ? tutor.job : undefined;
  const intent = pending?.request.intent;
  const selection = intent?.kind === 'answer' && typeof intent.answer === 'number' && body.mastery.activeCheck?.options?.[intent.answer];
  const pendingText = intent?.kind === 'ask' ? intent.text : selection && intent?.kind === 'answer' ? [selection, intent.reasoning].filter(Boolean).join('\n') : '';
  return <>
    <header className="thread-heading"><span className="tutor-mark"><Icon name="layer" /></span>
      <div><b>Delve tutor</b><small>Lesson conversation</small></div><LatestInstrumentLink body={body} compact /><small className="local-status">● &nbsp;Saved locally</small>
    </header>
    <Transcript scope={scope} lastMessage={body.messages.at(-1)?.id} pendingTurn={pending?.id}>
      {body.invalidLatest && body.revision && <section className="reader-notice" role="status">
        <p>The newest lesson could not be displayed. You can continue with the last readable version.</p>
        <button disabled={tutor.pending || !tutor.signedIn} onClick={() => tutor.prepare({ kind: 'teach' })}>Retry lesson generation</button>
        {tutor.provider !== 'demo' && <button disabled={tutor.pending || !tutor.signedIn} onClick={() => tutor.prepare({ kind: 'teach' }, true)}>Preview lesson request</button>}
      </section>}
      {body.blocks.length > 0 && <section id="opening-lesson"><span className="message-author">Delve tutor</span>
        <LessonBlocks blocks={body.blocks} /></section>}
      {body.mastery.needsAdaptation && <section><strong>Saved question</strong><p>{body.mastery.activeCheck?.prompt}</p>
        {body.mastery.activeCheck?.options && <ol>{body.mastery.activeCheck.options.map((choice, i) => <li key={i}>{choice}</li>)}</ol>}</section>}
      <Conversation messages={body.messages} earlierMessages={body.earlierMessages} />
      {pendingText && <div className="reader-message reader-message-learner"><span className="message-author">You · sending</span><p>{pendingText}</p></div>}
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
  const scope = lessonKey(address);
  const { draft, change } = useLessonDraft(scope, body.mastery, props.initialQuestion);
  function commit(next: ReaderLesson) { setBody(next); props.onEvidence?.(next); }
  const tutor = useTutor(address, title, props.graph.demo, (lesson, intent) => {
    if (intent.kind === 'ask' && draft.question.trim() === intent.text) change({ question: '' });
    commit(lesson);
  });
  const opening = useOpenLesson(body, tutor, props.initialReview);
  const skip = useSkip(address, body, commit);
  const { dismiss } = useTutorJobs();
  function refresh() {
    if (tutor.job?.phase === 'failed') dismiss(tutor.job);
    reload();
  }
  const activity = useContext(EnvironmentActivity);
  const lessonActivity = activity && { ...activity, onUse: (key: string, name: string) => {
    if (draft.mode !== 'ask') change({ mode: 'ask' });
    activity.onUse(key, name);
  } };
  return <div className="field-lesson"><EnvironmentActivity.Provider value={lessonActivity}>
    <LessonInstruments address={address} body={body} onLesson={commit}>
      <LessonHeading props={props} title={title}><LessonNotes props={props} body={body} tutor={tutor} busy={skip.busy || tutor.pending}
        skip={skip.skip} review={() => body.mastery.revision && tutor.prepare({ kind: 'review', revision: body.mastery.revision })} /></LessonHeading>
      <div className="lesson-columns"><article className="reader-thread" aria-label="Lesson and conversation">
        <Thread body={body} tutor={tutor} scope={scope} />
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
    <button className="back" onClick={props.onBack}>← Back to atlas</button><p role="alert">This workspace does not contain the selected concept.</p>
  </>;
  return <Reader key={[props.workspace.id, props.conceptId, props.depth, props.graph.snapshot, version].join('/')} props={props} title={concept.title} reload={() => update(value => value + 1)} />;
}
