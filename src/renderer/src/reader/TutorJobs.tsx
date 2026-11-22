import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LessonAddress, TutorRequest } from '../../../shared/reader';
import { preferredProvider, PROVIDER_LABELS } from '../preferences';
import { errorMessage } from '../useRead';
import { useQueue, type TutorJob } from './TutorQueue';

export { lessonKey } from '../../../shared/reader';
export const tutorName = (provider: TutorRequest['provider']) => provider === 'demo' ? 'the offline tutor' : PROVIDER_LABELS[provider];

export interface ReadingPosition {
  top: number;
  following: boolean;
  seen?: number;
}

export interface LessonDraft {
  mode: 'answer' | 'ask';
  question: string;
  revision: string | null;
  choice?: number;
  reasoning: string;
}

function useTutorActivity() {
  const queue = useQueue();
  const [positions] = useState(() => new Map<string, ReadingPosition>());
  const [drafts] = useState(() => new Map<string, LessonDraft>());
  const [visible, setVisible] = useState<string>();
  const [openError, setOpenError] = useState('');
  return { ...queue, positions, drafts, visible, setVisible, openError, setOpenError };
}

const TutorJobsContext = createContext<ReturnType<typeof useTutorActivity> | null>(null);

export function TutorJobsProvider({ children }: { children: ReactNode }) {
  return <TutorJobsContext.Provider value={useTutorActivity()}>{children}</TutorJobsContext.Provider>;
}

export function useBackgroundTutorCompletion(refresh: () => void) {
  const { jobs, visible } = useTutorJobs();
  const previous = useRef(new Set<string>());
  useEffect(() => {
    const ready = new Set([...jobs.values()].filter(job => job.phase === 'ready' && job.key !== visible
      && job.request.intent.kind !== 'ask').map(job => job.id));
    if ([...ready].some(id => !previous.current.has(id))) refresh();
    previous.current = ready;
  }, [jobs, visible, refresh]);
}

export function useTutorJobs() {
  const queue = useContext(TutorJobsContext);
  if (!queue) throw new Error('Tutor jobs require the desktop provider.');
  return queue;
}

function jobLabel(job: TutorJob) {
  const opening = job.request.intent.kind === 'teach';
  switch (job.phase) {
    case 'running': return opening ? 'Preparing lesson' : 'Preparing tutor response';
    case 'cancelling': return 'Cancelling tutor request';
    case 'ready': return opening ? 'Lesson ready' : 'Tutor response ready';
    case 'failed': {
      if (job.code === 'TUTOR_INTERRUPTED') return 'Tutor request interrupted';
      return job.code === 'TUTOR_CANCELLED' ? 'Tutor request cancelled' : 'Tutor request failed';
    }
  }
}

function JobNotice({ job, onOpen }: { job: TutorJob; onOpen: () => void }) {
  const { cancel, dismiss, retry } = useTutorJobs();
  const inProgress = job.phase === 'running' || job.phase === 'cancelling';
  const interrupted = job.phase === 'failed' && job.code === 'TUTOR_INTERRUPTED';
  const provider = job.request.provider === 'demo' ? 'demo' : preferredProvider();
  const canRetry = interrupted && provider === job.request.provider;
  return <li className="map-job">
    <div role="status"><strong>{jobLabel(job)} · {job.title}</strong>
      {job.phase === 'failed' && <div>{job.message}</div>}
      {canRetry && <div>Retry will use {tutorName(provider)}.</div>}
      {interrupted && !canRetry && <div>Open the lesson to review the request for {tutorName(provider)}.</div>}
      {job.phase === 'running' && job.warning && <div>{job.warning}</div>}
    </div>
    <div className="actions">
      <button onClick={onOpen}>Open lesson</button>
      {job.phase === 'running' && <button onClick={() => void cancel(job)}>Cancel tutor request</button>}
      {canRetry && <button onClick={() => retry(job, provider === 'demo' ? 'demo' : preferredProvider())}>Retry</button>}
      {!inProgress && <button onClick={() => void dismiss(job)}>Dismiss</button>}
    </div>
  </li>;
}

export function TutorJobStatus({ onOpen }: { onOpen: (address: LessonAddress) => void | Promise<void> }) {
  const { jobs, visible, openError, setOpenError, saved, dismissError } = useTutorJobs();
  const notices = [...jobs.values()].filter(job => job.key !== visible);
  async function open({ request: { workspaceId, conceptId, depth } }: TutorJob) {
    setOpenError('');
    try {
      await onOpen({ workspaceId, conceptId, depth });
    } catch (cause) {
      setOpenError('Could not open the lesson. ' + errorMessage(cause));
    }
  }

  if (!notices.length && !openError && !saved.error && !dismissError) return null;
  return <section className="map-jobs" aria-label="Tutor activity">
    {openError && <p role="alert">{openError}</p>}
    {saved.error && <p role="alert">{saved.error} <button onClick={saved.reload}>Retry loading tutor activity</button></p>}
    {dismissError && <p role="alert">{dismissError}</p>}
    <ul>{notices.map(job => <JobNotice key={job.id} job={job} onOpen={() => void open(job)} />)}</ul>
  </section>;
}
