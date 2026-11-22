import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { LessonAddress, ReaderLesson, TutorIntent, TutorPreview, TutorRequest } from '../../../shared/reader';
import { call, IpcCallError } from '../api';
import { providerHint, useDetectedProvider, useProviderDetection } from '../SetupProvider';
import { errorMessage } from '../useRead';
import { hasTutorApproval, setTutorApproval } from './tutorApproval';
import { lessonKey, useTutorJobs } from './TutorJobs';
import { TutorConsent, TutorPreviewDialog } from './TutorPreview';

type Provider = TutorRequest['provider'];
interface Preview { request: TutorRequest; data: TutorPreview; exact: boolean }

function useTutorPreview(start: (request: TutorRequest, token: string) => boolean, key: string) {
  const active = useRef<symbol | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<Preview>();
  useEffect(() => () => { active.current = null; }, [key]);

  async function prepare(request: TutorRequest, exact: boolean, allowed: boolean) {
    if (active.current) return;
    const id = Symbol();
    active.current = id;
    setPreview(undefined);
    setError('');
    setCode('');
    setPending(true);
    try {
      const data = await call('tutor:preview', request);
      if (active.current !== id) return;
      if (exact || !allowed || (request.provider !== 'demo' && !hasTutorApproval(request.workspaceId, request.provider))) setPreview({ request, data, exact });
      else if (!start(request, data.token)) setError('A tutor request is already running for this lesson.');
    } catch (cause) {
      if (active.current === id) {
        setCode(cause instanceof IpcCallError ? cause.code : '');
        setError('Could not prepare the tutor request. ' + errorMessage(cause));
      }
    } finally {
      if (active.current === id) {
        active.current = null;
        setPending(false);
      }
    }
  }

  function close() {
    setPreview(undefined);
    setError('');
  }

  return { prepare, pending, preview, error, code, setError, close };
}

function useApproval(address: LessonAddress, provider: Provider, refresh: () => void) {
  const [error, setError] = useState('');
  const permitted = provider === 'demo' || hasTutorApproval(address.workspaceId, provider);
  function setAllowed(allowed: boolean, reviewedProvider = provider) {
    if (reviewedProvider === 'demo') return false;
    try {
      setTutorApproval(address.workspaceId, reviewedProvider, allowed);
      setError('');
      refresh();
      return true;
    } catch (cause) {
      setError('Could not save tutor permission. ' + errorMessage(cause));
      return false;
    }
  }
  return { permitted, error, setAllowed, clear: () => setError('') };
}

function useAddressJob(address: LessonAddress, onLesson: (lesson: ReaderLesson, intent: TutorIntent) => void) {
  const { jobs, setVisible, dismiss } = useTutorJobs();
  const key = lessonKey(address);
  const job = jobs.get(key);
  const apply = useEffectEvent(() => {
    if (job?.phase !== 'ready') return;
    onLesson(job.lesson, job.request.intent);
    dismiss(job);
  });

  useEffect(() => {
    setVisible(key);
    return () => setVisible(previous => previous === key ? undefined : previous);
  }, [key, setVisible]);
  useEffect(() => { apply(); }, [job]);

  return job;
}

export function useTutor(address: LessonAddress, title: string, demo: boolean, onLesson: (lesson: ReaderLesson, intent: TutorIntent) => void) {
  const [, update] = useState(0);
  const [lastIntent, setLastIntent] = useState<TutorIntent>();
  const queue = useTutorJobs();
  const job = useAddressJob(address, onLesson);
  const detection = useProviderDetection(!demo);
  const { provider: detected, choose, cli: status } = useDetectedProvider(detection.statuses);
  const provider: Provider = demo ? 'demo' : detected;
  const approval = useApproval(address, provider, () => update(version => version + 1));
  const start = (request: TutorRequest, token: string) => queue.start({ request, token, title });
  const review = useTutorPreview(start, lessonKey(address));
  const signedIn = demo || status?.state === 'signed-in';
  const running = job?.phase === 'running' || job?.phase === 'cancelling';

  function prepare(intent: TutorIntent, exact = false) {
    if (running || !signedIn) return;
    setLastIntent(intent);
    approval.clear();
    void review.prepare({ ...address, provider, intent }, exact, approval.permitted);
  }

  function approve(always: boolean) {
    const preview = review.preview;
    if (!preview || preview.request.provider !== provider || !signedIn || (always && !approval.setAllowed(true, preview.request.provider))) return;
    if (start(preview.request, preview.data.token)) review.close();
    else review.setError('A tutor request is already running for this lesson.');
  }

  function changeProvider(next: 'codex' | 'claude') {
    review.close();
    choose(next);
  }

  return { job, detection, provider, status, signedIn, prepare, lastIntent, choose: changeProvider, approve, approval, review,
    pending: running || review.pending, running, cancel: () => job && queue.cancel(job) };
}

export type LessonTutor = ReturnType<typeof useTutor>;

export function TutorSettings({ tutor }: { tutor: LessonTutor }) {
  const { provider, choose, detection, status, pending, approval } = tutor;
  if (provider === 'demo') return <p>Offline demo tutor · Saved on this device</p>;
  return <div className="reader-provider">
    <label htmlFor="tutor-provider">Tutor</label>
    <select id="tutor-provider" value={provider} disabled={pending}
      onChange={event => { approval.clear(); choose(event.target.value === 'claude' ? 'claude' : 'codex'); }}>
      <option value="codex">Codex</option><option value="claude">Claude Code</option>
    </select>
    <span className="smallprint" role="status">{detection.error || (status && providerHint(status)) || 'Checking sign-in…'}</span>
    {status?.state !== 'signed-in' && !detection.checking &&
      <button type="button" onClick={detection.retry}>Check sign-in again</button>}
    {approval.permitted && <button type="button" disabled={pending} onClick={() => approval.setAllowed(false)}>Revoke workspace tutor permission</button>}
    {approval.error && <p role="alert">{approval.error}</p>}
  </div>;
}

export function TutorReview({ tutor }: { tutor: LessonTutor }) {
  const { review, approve, approval } = tutor;
  if (!review.preview || review.preview.request.provider !== tutor.provider) return null;
  const props = { ...review.preview, approve, error: approval.error || review.error, close: review.close };
  return review.preview.exact ? <TutorPreviewDialog {...props} /> : <TutorConsent {...props} />;
}

export function TutorTurnStatus({ tutor, onBackground, reload }: { tutor: LessonTutor; onBackground: () => void; reload: () => void }) {
  const { job, review, pending, lastIntent } = tutor;
  if (pending) return <div className="reader-turn-status">
    {job?.phase === 'running' && <span className="thinking-bars" aria-hidden="true"><i /><i /><i /><i /></span>}
    <strong role="status">{review.pending ? 'Preparing request…' : job?.phase === 'cancelling' ? 'Cancelling…' :
      'Tutor is thinking…'}</strong>
    {job?.phase === 'running' && <span className="turn-context">{job.request.intent.kind === 'answer' ? 'Checking your choice.' : job.request.intent.kind === 'teach' ? 'Preparing lesson…' : 'Preparing response…'}</span>}
    {job?.phase === 'running' && <div className="actions">
      <button type="button" onClick={onBackground}>Continue in background</button>
      <button type="button" onClick={() => void tutor.cancel()}>Cancel tutor request</button>
    </div>}
    {job?.phase === 'running' && job.warning && <p role="alert">{job.warning}</p>}
  </div>;

  const failure = job?.phase === 'failed' ? job : undefined;
  const message = review.error || failure?.message;
  if (!message || review.preview) return null;
  const intent = lastIntent ?? failure?.request.intent;
  const stale = ['LESSON_CHANGED', 'STALE_PREVIEW'].includes(review.code || failure?.code || '');
  return <div className="reader-turn-status" role="alert"><span>{stale ? 'The question changed. Review the current check.' :
    (intent?.kind === 'answer' ? 'Your answer hasn’t been saved. ' : '') + message}</span>
    {stale && <button onClick={reload}>Load current check</button>}
    {!stale && intent && failure?.code !== 'PROVIDER_QUOTA' && <button type="button" onClick={() =>
      tutor.prepare(intent)}>Retry</button>}
  </div>;
}
