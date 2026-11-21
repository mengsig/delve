import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import type { LessonAddress, ReaderLesson, TutorRequest } from '../../../shared/reader';
import { call, IpcCallError } from '../api';
import { errorMessage } from '../useRead';

type Phase = { phase: 'running'; warning?: string } | { phase: 'cancelling' }
  | { phase: 'ready'; lesson: ReaderLesson } | { phase: 'failed'; message: string; code?: string };

interface JobInput {
  request: TutorRequest;
  title: string;
}

export type TutorJob = JobInput & Phase & { id: string; key: string };
export const lessonKey = ({ workspaceId, conceptId, depth }: LessonAddress) => [workspaceId, conceptId, depth].join('/');

function useJobStore() {
  const [jobs, setJobs] = useState<ReadonlyMap<string, TutorJob>>(() => new Map());
  function add(job: TutorJob) {
    setJobs(previous => new Map(previous).set(job.key, job));
  }

  function replace(job: TutorJob, next?: TutorJob) {
    if (next && (next.id !== job.id || next.key !== job.key)) throw new Error('Tutor job identity changed.');
    setJobs(previous => {
      if (previous.get(job.key)?.id !== job.id) return previous;
      const changed = new Map(previous);
      if (next) changed.set(job.key, next);
      else changed.delete(job.key);
      return changed;
    });
  }

  return { jobs, add, replace };
}

function useQueue() {
  const { jobs, add, replace } = useJobStore();
  const running = useRef(new Map<string, TutorJob>());


  async function generate(job: TutorJob, token: string) {
    try {
      const lesson = await call('tutor:run', { ...job.request, token, requestId: job.id });
      replace(job, { ...job, phase: 'ready', lesson });
    } catch (cause) {
      replace(job, { ...job, phase: 'failed', message: errorMessage(cause), code: cause instanceof IpcCallError ? cause.code : undefined });
    } finally {
      running.current.delete(job.key);
    }
  }

  function start({ token, ...input }: JobInput & { token: string }) {
    const key = lessonKey(input.request);
    if (!token || !input.title.trim()) throw new Error('Tutor jobs need a reviewed request and lesson title.');
    if (running.current.has(key)) return false;
    const job: TutorJob = { ...input, id: crypto.randomUUID(), key, phase: 'running' };
    running.current.set(key, job);
    add(job);
    void generate(job, token);
    return true;
  }

  function reportFailure(request: TutorRequest, title: string, cause: unknown) {
    const key = lessonKey(request);
    if (running.current.has(key)) return;
    add({ request, title, key, id: crypto.randomUUID(),
      phase: 'failed', code: cause instanceof IpcCallError ? cause.code : undefined, message: errorMessage(cause) });
  }

  async function cancel(job: TutorJob) {
    const current = running.current.get(job.key);
    if (current?.id !== job.id || current.phase !== 'running') return;
    const runningJob = current;
    const cancelling: TutorJob = { ...runningJob, phase: 'cancelling' };
    running.current.set(job.key, cancelling);
    replace(job, cancelling);
    try {
      const cancelled = await call('tutor:cancel', { requestId: job.id });
      if (!cancelled && running.current.get(job.key)?.id === job.id) restore('The tutor request is finishing.');
    } catch (cause) {
      if (running.current.get(job.key)?.id !== job.id) return;
      restore('Could not cancel the tutor. ' + errorMessage(cause));
    }
    function restore(warning: string) {
      const restored: TutorJob = { ...runningJob, warning };
      running.current.set(job.key, restored);
      replace(job, restored);
    }
  }

  return { jobs, start, reportFailure, cancel,
    dismiss: (job: TutorJob) => { if (!running.current.has(job.key)) replace(job); } };
}

function useTutorActivity() {
  const queue = useQueue();
  const positions = useRef(new Map<string, number>());
  const [visible, setVisible] = useState<string>();
  const [openError, setOpenError] = useState('');
  return { ...queue, positions, visible, setVisible, openError, setOpenError };
}

const TutorJobsContext = createContext<ReturnType<typeof useTutorActivity> | null>(null);

export function TutorJobsProvider({ children }: { children: ReactNode }) {
  return <TutorJobsContext.Provider value={useTutorActivity()}>{children}</TutorJobsContext.Provider>;
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
    case 'failed': return job.code === 'TUTOR_CANCELLED' ? 'Tutor request cancelled' : 'Tutor request failed';
  }
}

function JobNotice({ job, onOpen }: { job: TutorJob; onOpen: () => void }) {
  const { cancel, dismiss } = useTutorJobs();
  const inProgress = job.phase === 'running' || job.phase === 'cancelling';
  return <li className="map-job">
    <div role="status"><strong>{jobLabel(job)} · {job.title}</strong>
      {job.phase === 'failed' && <div>{job.message}</div>}
      {job.phase === 'running' && job.warning && <div>{job.warning}</div>}
    </div>
    <div className="actions">
      <button onClick={onOpen}>Open lesson</button>
      {job.phase === 'running' && <button onClick={() => void cancel(job)}>Cancel tutor request</button>}
      {!inProgress && <button onClick={() => dismiss(job)}>Dismiss</button>}
    </div>
  </li>;
}

export function TutorJobStatus({ onOpen }: { onOpen: (address: LessonAddress) => void | Promise<void> }) {
  const { jobs, visible, openError, setOpenError } = useTutorJobs();
  const notices = [...jobs.values()].filter(job => job.key !== visible);
  async function open({ request: { workspaceId, conceptId, depth } }: TutorJob) {
    setOpenError('');
    try {
      await onOpen({ workspaceId, conceptId, depth });
    } catch (cause) {
      setOpenError('Could not open the lesson. ' + errorMessage(cause));
    }
  }

  if (!notices.length && !openError) return null;
  return <section className="map-jobs" aria-label="Tutor activity">
    {openError && <p role="alert">{openError}</p>}
    <ul>{notices.map(job => <JobNotice key={job.id} job={job} onOpen={() => void open(job)} />)}</ul>
  </section>;
}
