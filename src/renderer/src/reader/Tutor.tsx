import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { LessonAddress, ReaderLesson, TutorIntent, TutorPreview, TutorRequest } from '../../../shared/reader';
import { call } from '../api';
import { providerHint, useDetectedProvider, useProviderDetection } from '../SetupProvider';
import { errorMessage } from '../useRead';
import { hasTutorApproval, setTutorApproval } from './tutorApproval';
import { lessonKey, useTutorJobs } from './TutorJobs';
import { TutorPreviewDialog } from './TutorPreview';

type Provider = TutorRequest['provider'];
interface Preview { request: TutorRequest; data: TutorPreview; exact: boolean }

function useTutorPreview(start: (request: TutorRequest, token: string) => boolean, key: string) {
  const active = useRef<symbol | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview>();
  useEffect(() => () => { active.current = null; }, [key]);

  async function prepare(request: TutorRequest, exact: boolean, allowed: boolean) {
    if (active.current) return;
    const id = Symbol();
    active.current = id;
    setPreview(undefined);
    setError('');
    setPending(true);
    try {
      const data = await call('tutor:preview', request);
      if (active.current !== id) return;
      if (exact || !allowed) setPreview({ request, data, exact });
      else if (!start(request, data.token)) setError('A tutor request is already running for this lesson.');
    } catch (cause) {
      if (active.current === id) setError('Could not prepare the tutor request. ' + errorMessage(cause));
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

  return { prepare, pending, preview, error, setError, close };
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
  const provider = demo ? 'demo' : detected;
  const approval = useApproval(address, provider, () => update(version => version + 1));
  const start = (request: TutorRequest, token: string) => queue.start({ request, token, title });
  const review = useTutorPreview(start, lessonKey(address));
  const running = job?.phase === 'running' || job?.phase === 'cancelling';

  function prepare(intent: TutorIntent, exact = false) {
    if (running) return;
    setLastIntent(intent);
    approval.clear();
    void review.prepare({ ...address, provider, intent }, exact, approval.permitted);
  }

  function approve(always: boolean) {
    const preview = review.preview;
    if (!preview || (always && !approval.setAllowed(true, preview.request.provider))) return;
    if (start(preview.request, preview.data.token)) review.close();
    else review.setError('A tutor request is already running for this lesson.');
  }

  return { job, detection, provider, status, prepare, lastIntent, choose, approve, approval, review,
    pending: running || review.pending, running, cancel: () => job && queue.cancel(job) };
}

export function TutorControls({ tutor, demo, canStart }: { tutor: ReturnType<typeof useTutor>; demo: boolean; canStart: boolean }) {
  const { provider, choose, detection, status, pending, prepare, approve, approval, review } = tutor;
  return <>
    {!demo && <div className="reader-provider">
      <label htmlFor="tutor-provider">Tutor</label>
      <select id="tutor-provider" value={provider} disabled={pending}
        onChange={event => { approval.clear(); choose(event.target.value === 'claude' ? 'claude' : 'codex'); }}>
        <option value="codex">Codex</option><option value="claude">Claude Code</option>
      </select>
      <span className="smallprint" role="status">{detection.error || (status && providerHint(status)) || 'Checking sign-in…'}</span>
      {status?.state !== 'signed-in' && !detection.checking &&
        <button type="button" disabled={pending} onClick={detection.retry}>Check sign-in again</button>}
      {approval.permitted && <button type="button" disabled={pending} onClick={() => approval.setAllowed(false)}>Revoke workspace tutor permission</button>}
      {approval.error && !review.preview && <p role="alert">{approval.error}</p>}
    </div>}
    {canStart && <div className="actions reader-start">
      <button className="primary-btn" disabled={pending} onClick={() => prepare({ kind: 'teach' })}>Start lesson</button>
      {!demo && <button disabled={pending} onClick={() => prepare({ kind: 'teach' }, true)}>Preview lesson request</button>}
    </div>}
    {review.preview && <TutorPreviewDialog {...review.preview} approve={approve}
      error={approval.error || review.error} close={review.close} />}
  </>;
}

export function TutorTurnStatus({ tutor, onBackground }: { tutor: ReturnType<typeof useTutor>; onBackground: () => void }) {
  const { job, review, pending, lastIntent } = tutor;
  if (pending) return <div className="reader-turn-status">
    <span role="status">{review.pending ? 'Preparing request…' : job?.phase === 'cancelling' ? 'Cancelling…' :
      job?.request.intent.kind === 'teach' ? 'Preparing lesson…' : 'Preparing response…'}</span>
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
  return <div className="reader-turn-status" role="alert"><span>{message}</span>
    {intent && failure?.code !== 'PROVIDER_QUOTA' && <button type="button" onClick={() =>
      tutor.prepare(intent, failure?.code === 'STALE_PREVIEW')}>Retry</button>}
  </div>;
}
