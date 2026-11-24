import { useEffect, useId, useRef, useState } from 'react';
import type { FoundationProgress, FoundationStep, LessonAddress, ReaderContract } from '../../../shared/reader';
import { call } from '../api';
import { errorMessage } from '../useRead';

type Decision = NonNullable<ReaderContract['reader:foundation']['request']['decision']>;
type Completion = Omit<FoundationProgress, 'step'>;

export function FoundationActivity({ address, initial, onComplete }: {
  address: LessonAddress & { lessonId?: number };
  initial: FoundationStep;
  onComplete: (completion: Completion) => Promise<void> | void;
}) {
  const [step, setStep] = useState(initial);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const lock = useRef(false);
  const [completion, setCompletion] = useState<Completion>();
  const titleId = useId();
  const probing = step.phase === 'probe';
  useEffect(() => { heading.current?.focus(); }, [step.revision]);

  async function respond(answer: Decision['answer']) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      if (completion) { await onComplete(completion); return; }
      const next = await call('reader:foundation', { ...address, decision: { answer, revision: step.revision } });
      setFeedback(next.feedback ?? '');
      if (next.step) setStep(next.step);
      else {
        const completed = { feedback: next.feedback, foundationIntroduction: next.foundationIntroduction };
        setCompletion(completed);
        await onComplete(completed);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return <section className="foundation-activity" aria-labelledby={titleId} aria-busy={busy}>
    <p className="smallprint">{probing ? 'Quick questions' : 'Foundation lesson'} · {step.position} of {step.total}</p>
    <h2 id={titleId} tabIndex={-1} ref={heading}>{probing ? 'What do you know about ' + step.title + '?'
      : (step.goDeeper ? 'Go deeper on ' : 'A quick look at ') + step.title}</h2>
    {feedback && <p role="status" className="reader-observation">{feedback}</p>}
    <p>{step.why}</p>
    {step.phase === 'practice' && <p>{step.explanation}</p>}
    <fieldset disabled={busy || !!completion}>
      <legend>{step.prompt}</legend>
      <div className="foundation-options">{step.options.map((option, index) =>
        <button key={index} onClick={() => void respond(index)}>{option}</button>)}</div>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <button className="back" disabled={busy} onClick={() => void respond(null)}>
      {completion ? 'Continue to lesson' : probing ? 'Skip questions' : 'Skip to lesson'}
    </button>
  </section>;
}
