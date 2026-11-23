import { useLayoutEffect, useRef } from 'react';
import type { ReaderLesson, TutorIntent } from '../../../shared/reader';
import { AnswerCheck } from './AnswerCheck';
import { Composer } from './Conversation';
import { Completion, Practice } from './Mastery';
import { TutorReview, TutorSettings, TutorTurnStatus, type LessonTutor } from './Tutor';
import type { LessonDraft } from './TutorJobs';
import type { ReaderProps } from './ReaderHeader';

interface Props {
  body: ReaderLesson;
  props: ReaderProps & { conceptId: number; onBackToChange?: () => void; initialQuestion?: string };
  tutor: LessonTutor;
  opening: TutorIntent | null;
  title: string;
  draft: LessonDraft;
  change: (update: Partial<LessonDraft>) => void;
  reload: () => void;
  busy: boolean;
}

function EmptyCheck({ body, tutor, opening }: Pick<Props, 'body' | 'tutor' | 'opening'>) {
  const adapt = body.mastery.needsAdaptation;
  if (!adapt && body.invalidLatest && !body.revision) return null;
  return <section className="empty-check">
    <strong>{adapt ? 'Update this saved check' : 'Your first check will appear here.'}</strong>
    {adapt && <p>Your original question is in the conversation. Prepare choices to continue this round.</p>}
    <button disabled={!tutor.signedIn || tutor.pending} onClick={() => tutor.prepare(opening ?? { kind: 'teach' })}>
      {adapt ? 'Prepare four choices' : 'Start lesson'}
    </button>
  </section>;
}

function DockTabs({ draft, change, body }: Pick<Props, 'draft' | 'change' | 'body'>) {
  const { attempts, maxAttempts, correctAnswers } = body.mastery;
  return <div className="dock-tools"><div className="dock-tabs" role="group" aria-label="Response mode">
    <button aria-pressed={draft.mode === 'answer'} onClick={() => change({ mode: 'answer' })}>Answer check</button>
    <button aria-pressed={draft.mode === 'ask'} onClick={() => { change({ mode: 'ask' }); requestAnimationFrame(() => document.getElementById('reader-question')?.focus({ preventScroll: true })); }}>Ask tutor</button></div>
    <span className="check-budget">{maxAttempts - attempts} tries left <b>↗ {correctAnswers} in a row</b></span>
  </div>;
}

export function ResponseDock({ body, props, tutor, opening, title, draft, change, reload, busy }: Props) {
  const { mastery } = body;
  const done = mastery.stage === 'understood';
  const paused = mastery.stage === 'skipped' || mastery.stage === 'review';
  const check = mastery.activeCheck;
  const consent = Boolean(tutor.review.preview && !tutor.review.preview.exact);
  const dock = useRef<HTMLElement>(null);
  const restore = useRef('');
  function rememberFocus() {
    const target = document.activeElement;
    if (target instanceof HTMLElement && dock.current?.contains(target)) {
      restore.current = target.id || 'first-choice';
    }
  }
  const held = tutor.pending || consent;
  useLayoutEffect(() => {
    if (!held && restore.current && document.activeElement === document.body) {
      const target = document.getElementById(restore.current) ??
        dock.current?.querySelector<HTMLElement>('.answer-options button, .lesson-completion .primary-btn, button:not(:disabled)');
      target?.focus({ preventScroll: true });
    }
    if (!held) restore.current = '';
  }, [held]);
  const composer = <Composer tutor={tutor} draft={draft.question} setDraft={question => change({ question })} secondary={done || paused} focusOnOpen={Boolean(props.initialQuestion) && !held} />;
  return <section className="response-dock" ref={dock} aria-label="Lesson response" onSubmitCapture={rememberFocus}>
    <TutorTurnStatus tutor={tutor} onBackground={props.onBackToChange ?? props.onBack} reload={reload} />
    <TutorReview tutor={tutor} />
    {tutor.running && composer}
    {!tutor.signedIn && !tutor.detection.checking && <TutorSettings tutor={tutor} />}
    {!held && <>
      {done && <Completion props={props} mastery={mastery} tutor={tutor} title={title} />}
      {paused && <Practice props={props} mastery={mastery} tutor={tutor} />}
      {!done && !paused && <DockTabs draft={draft} change={change} body={body} />}
      {done || paused || draft.mode === 'ask' ? composer :
        check?.options && mastery.revision && !mastery.needsAdaptation ?
          <AnswerCheck check={check} revision={mastery.revision} draft={draft} change={change}
            disabled={busy || !tutor.signedIn || Boolean(tutor.review.preview)} preview={!props.graph.demo} submit={(intent, exact) => { rememberFocus(); tutor.prepare(intent, exact); }} /> :
          <EmptyCheck body={body} opening={opening} tutor={tutor} />}
    </>}
  </section>;
}
