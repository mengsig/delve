import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { lessonKey, type ReaderLesson, type SavedTutorJob, type TutorRequest } from '../../../shared/reader';
import { call, IpcCallError } from '../api';
import { errorMessage } from '../useRead';

type Phase = { phase: 'running'; warning?: string } | { phase: 'cancelling' }
  | { phase: 'ready'; lesson?: ReaderLesson } | { phase: 'failed'; message: string; code?: string };

export interface JobInput {
  request: TutorRequest;
  title: string;
}

export type TutorJob = JobInput & Phase & { id: string; key: string; submittedAnswer?: string };

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

  return { jobs, add, replace, restore: (entries: TutorJob[]) => setJobs(new Map(entries.map(job => [job.key, job]))) };
}

function useSavedJobs(restore: (jobs: SavedTutorJob[]) => void) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const loaded = useEffectEvent(restore);
  useEffect(() => {
    let current = true;
    void call('tutor:jobs', null).then(jobs => {
      if (!current) return;
      loaded(jobs);
      setReady(true);
    }, cause => {
      if (current) setError('Could not load tutor activity. ' + errorMessage(cause));
    });
    return () => { current = false; };
  }, [attempt]);
  return { ready, error, reload: () => { setError(''); setAttempt(value => value + 1); } };
}

function useLiveJobs({ replace }: ReturnType<typeof useJobStore>) {
  const running = useRef(new Map<string, TutorJob>());

  async function follow(job: TutorJob, result: () => Promise<ReaderLesson>) {
    if (job.phase !== 'running' || running.current.has(job.key)) throw new Error('A tutor request is already active.');
    running.current.set(job.key, job);
    try {
      const lesson = await result();
      replace(job, { ...job, phase: 'ready', lesson });
    } catch (cause) {
      replace(job, { ...job, phase: 'failed', message: errorMessage(cause), code: cause instanceof IpcCallError ? cause.code : undefined });
    } finally {
      running.current.delete(job.key);
    }
  }

  return { follow, busy: (key: string) => running.current.has(key),
    cancel: (job: TutorJob) => cancelJob(running.current, replace, job) };
}

export function useQueue() {
  const store = useJobStore();
  const { jobs, add, replace, restore } = store;
  const { busy, follow, cancel } = useLiveJobs(store);
  const [dismissError, setDismissError] = useState('');
  const saved = useSavedJobs(entries => {
    const hydrated = entries.map(entry => ({ ...entry, key: lessonKey(entry.request) }));
    restore(hydrated);
    for (const job of hydrated) {
      if (job.phase === 'running') void follow(job, () => call('tutor:wait', { requestId: job.id }));
    }
  });

  function start({ token, ...input }: JobInput & { token: string }) {
    const key = lessonKey(input.request);
    if (!token || !input.title.trim()) throw new Error('Tutor jobs need a reviewed request and lesson title.');
    if (!saved.ready || busy(key)) return false;
    const job: TutorJob = { ...input, id: crypto.randomUUID(), key, phase: 'running' };
    add(job);
    void follow(job, () => call('tutor:run', { ...job.request, token, requestId: job.id }));
    return true;
  }

  function retry(job: TutorJob, provider: TutorRequest['provider']) {
    if (job.phase !== 'failed' || job.code !== 'TUTOR_INTERRUPTED' || job.request.provider !== provider || busy(job.key)) return;
    const resumed = { ...job, phase: 'running' as const };
    replace(job, resumed);
    void follow(resumed, () => call('tutor:retry', { requestId: job.id, provider }));
  }

  function failRead(job: TutorJob, cause: IpcCallError) {
    if (!busy(job.key)) replace(job, { ...job, phase: 'failed', code: cause.code, message: cause.message });
  }

  function reportFailure(request: TutorRequest, title: string, cause: unknown) {
    const key = lessonKey(request);
    if (busy(key)) return;
    add({ request, title, key, id: crypto.randomUUID(),
      phase: 'failed', code: cause instanceof IpcCallError ? cause.code : undefined, message: errorMessage(cause) });
  }

  async function dismiss(job: TutorJob) {
    if (busy(job.key)) return;
    setDismissError('');
    try {
      await call('tutor:dismiss', { requestId: job.id });
      replace(job);
    } catch (cause) {
      setDismissError('Could not dismiss the tutor request. ' + errorMessage(cause));
    }
  }

  return { jobs, start, reportFailure, failRead, retry, dismiss, saved, dismissError, cancel };
}

async function cancelJob(running: Map<string, TutorJob>, replace: ReturnType<typeof useJobStore>['replace'], job: TutorJob) {
  const current = running.get(job.key);
  if (current?.id !== job.id || current.phase !== 'running') return;
  const runningJob = current;
  const cancelling: TutorJob = { ...runningJob, phase: 'cancelling' };
  running.set(job.key, cancelling);
  replace(job, cancelling);
  try {
    const cancelled = await call('tutor:cancel', { requestId: job.id });
    if (!cancelled && running.get(job.key)?.id === job.id) restore('The tutor request is finishing.');
  } catch (cause) {
    if (running.get(job.key)?.id !== job.id) return;
    restore('Could not cancel the tutor. ' + errorMessage(cause));
  }
  function restore(warning: string) {
    const restored: TutorJob = { ...runningJob, warning };
    running.set(job.key, restored);
    replace(job, restored);
  }
}
