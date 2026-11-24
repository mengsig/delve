import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Depth, ProviderId, Workspace } from '../../../shared/domain';
import type { ChangeRef, RepoPreview } from '../../../shared/repository';
import { call } from '../api';
import { errorMessage } from '../useRead';
import { repositoryFailure, type RepositoryFailure } from './useRepositoryGeneration';

interface StartMap {
  workspace: Workspace;
  depth: Depth;
  provider: ProviderId;
  preview: RepoPreview;
}

type StartChange = StartMap & { change: ChangeRef };
type JobInput = Omit<StartMap, 'preview'> & { token: string; files: readonly string[] };
type JobRequest = JobInput & ({ kind: 'map' } | { kind: 'change'; change: ChangeRef; title: string });
type JobState =
  | { phase: 'generating'; cancelError?: string }
  | { phase: 'cancelling' | 'cancelled' }
  | { phase: 'ready'; conceptId?: number; lessonId?: number }
  | { phase: 'failed'; failure: RepositoryFailure };

export type RepositoryJob = JobRequest & JobState & { key: string; requestId: string };
export type MapJob = Extract<RepositoryJob, { kind: 'map' }>;
export type ChangeJob = Extract<RepositoryJob, { kind: 'change' }>;

interface MapJobs {
  jobs: ReadonlyMap<string, RepositoryJob>;
  completions: ReadonlyMap<string, string>;
  start(input: StartMap): boolean;
  startChange(input: StartChange): boolean;
  cancel(job: RepositoryJob): Promise<void>;
  retry(job: MapJob): boolean;
  dismiss(job: RepositoryJob): void;
}

const MapJobsContext = createContext<MapJobs | null>(null);

export const mapJobKey = (workspaceId: string) => 'map/' + workspaceId;

export function changeJobKey(workspaceId: string, { kind, ref }: ChangeRef, depth: Depth) {
  return JSON.stringify(['change', workspaceId, kind, ref, depth]);
}

export function jobInProgress(job: RepositoryJob | undefined) {
  return job?.phase === 'generating' || job?.phase === 'cancelling';
}

function requestKey(request: JobRequest) {
  const { id, kind } = request.workspace;
  if (!id || kind === 'topic') throw new Error('Generation needs a repository workspace.');
  if (!request.token) throw new Error('Generation needs an approved preview.');
  return request.kind === 'map' ? mapJobKey(id) : changeJobKey(id, request.change, request.depth);
}

function useJobStore() {
  const [jobs, setJobs] = useState<ReadonlyMap<string, RepositoryJob>>(() => new Map());
  const [completions, setCompletions] = useState<ReadonlyMap<string, string>>(() => new Map());

  function replace(job: RepositoryJob, next: RepositoryJob | null) {
    if (next && (next.key !== job.key || next.requestId !== job.requestId)) {
      throw new Error('Job updates must belong to the same generation request.');
    }
    setJobs(previous => {
      if (previous.get(job.key)?.requestId !== job.requestId) return previous;
      const updated = new Map(previous);
      if (next) updated.set(job.key, next);
      else updated.delete(job.key);
      return updated;
    });
  }
  function complete(job: RepositoryJob, result?: { conceptId: number; lessonId?: number }) {
    setCompletions(previous => new Map(previous).set(job.workspace.id, job.requestId));
    replace(job, { ...job, phase: 'ready', ...result });
  }
  return { jobs, completions, replace, complete, add: (job: RepositoryJob) => setJobs(previous => new Map(previous).set(job.key, job)) };
}

async function generateRepository(job: RepositoryJob) {
  const result = await call('repo:generate', { token: job.token, requestId: job.requestId });
  const expected = job.kind === 'map' ? 'baseline' : 'change';
  if (result.kind !== expected) throw new Error('The provider returned a different type of result.');
  if (result.kind === 'baseline') return;
  if (result.brief.conceptId < 1) throw new Error('The change lesson was not saved. Review the request and retry.');
  return { conceptId: result.brief.conceptId, lessonId: result.brief.lessonId };
}

function useMapQueue(): MapJobs {
  const running = useRef(new Map<string, RepositoryJob>());
  const { jobs, completions, add, replace, complete } = useJobStore();

  async function generate(job: RepositoryJob) {
    try {
      complete(job, await generateRepository(job));
    } catch (cause) {
      const failure = repositoryFailure(cause);
      replace(job, failure.code === 'PROVIDER_CANCELLED' ? { ...job, phase: 'cancelled' } : { ...job, phase: 'failed', failure });
    } finally { running.current.delete(job.key); }
  }
  function enqueue(request: JobRequest) {
    const key = requestKey(request);
    if (running.current.has(key)) return false;
    const job: RepositoryJob = { ...request, key, phase: 'generating', requestId: crypto.randomUUID() };
    running.current.set(key, job);
    add(job);
    void generate(job);
    return true;
  }

  async function cancel(job: RepositoryJob) {
    const current = running.current.get(job.key);
    if (current?.requestId !== job.requestId || current.phase !== 'generating') return;
    const cancelling: RepositoryJob = { ...job, phase: 'cancelling' };
    running.current.set(job.key, cancelling);
    replace(job, cancelling);
    try {
      const requested = await call('repo:cancel', { requestId: job.requestId });
      if (!requested) restoreProgress(job, 'Cancellation is unavailable. This request may be finishing.');
    } catch (cause) {
      restoreProgress(job, 'Could not cancel the request. ' + errorMessage(cause));
    }
  }

  function restoreProgress(job: RepositoryJob, cancelError: string) {
    if (running.current.get(job.key)?.requestId !== job.requestId) return;
    const restored: RepositoryJob = { ...job, phase: 'generating', cancelError };
    running.current.set(job.key, restored);
    replace(job, restored);
  }

  return {
    jobs, completions, cancel,
    start: ({ preview, ...request }) => enqueue({ ...request, kind: 'map', token: preview.token, files: preview.files }),
    startChange: ({ preview, ...request }) =>
      enqueue({ ...request, kind: 'change', token: preview.token, files: preview.files, title: preview.title }),
    retry: job => {
      if (jobs.get(job.key)?.requestId !== job.requestId) return false;
      if (job.phase !== 'cancelled' && (job.phase !== 'failed' || job.failure.action !== 'retry')) return false;
      const { workspace, depth, provider, token, files } = job;
      return enqueue({ kind: 'map', workspace, depth, provider, token, files });
    },
    dismiss: job => {
      if (!running.current.has(job.key)) replace(job, null);
    },
  };
}

export function MapJobsProvider({ children }: { children: ReactNode }) {
  const queue = useMapQueue();
  return <MapJobsContext.Provider value={queue}>{children}</MapJobsContext.Provider>;
}

export function useMapJobs() {
  const queue = useContext(MapJobsContext);
  if (!queue) throw new Error('Repository jobs require the desktop provider.');
  return queue;
}

export function useRepositoryCompletion(workspaceId: string, refresh: () => void) {
  const completion = useMapJobs().completions.get(workspaceId);
  const lastRead = useRef(completion);
  useEffect(() => {
    if (completion === lastRead.current) return;
    lastRead.current = completion;
    refresh();
  }, [completion, refresh]);
}
