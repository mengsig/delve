import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import { lessonKey, type ReaderLesson, type SavedTutorJob, type TutorContract } from '../../shared/reader';
import type { Db } from '../db/connection';
import { readLesson } from '../reader/ipc';
import { findTutorJob, listTutorJobs, markTutorJobFailed, markTutorJobReady, removeTutorJob, storeTutorJob } from './jobs';
import { createGenerator, type Generate } from './provider';
import { checkedTurn, executeTurn } from './turn';

interface ActiveTurn {
  id: string;
  token: string;
  controller: AbortController;
  result: Promise<ReaderLesson>;
  subscribers: Set<string>;
}

const interrupted = { code: 'TUTOR_INTERRUPTED', message: 'Delve closed before the tutor finished.' };

export class TutorSession {
  private closed = false;
  private turns = new Map<string, ActiveTurn>();
  private cancellations = new Map<string, () => void>();
  constructor(private db: Db, private generate: Generate = createGenerator()) {}

  run(request: TutorContract['tutor:run']['request']): Promise<ReaderLesson> {
    if (this.closed) throw new DomainError('TUTOR_CLOSED', 'The tutor is closing.');
    const { requestId, token, ...input } = request;
    if (this.cancellations.has(requestId)) throw new DomainError('DUPLICATE_REQUEST', 'That request is already running.');
    const turn = checkedTurn(this.db, input, token);
    const key = lessonKey(input);
    let active = this.turns.get(key);
    if (active && active.token !== token) throw new DomainError('TUTOR_BUSY', 'Finish or cancel the current tutor response first.');
    if (!active) {
      const controller = new AbortController();
      storeTutorJob(this.db, requestId, turn);
      const result = executeTurn(this.db, this.generate, turn, controller.signal, () => markTutorJobReady(this.db, requestId))
        .catch((cause: unknown) => {
          if (!this.closed && !controller.signal.aborted) this.recordFailure(requestId, cause);
          throw cause;
        });
      active = { id: requestId, token, controller, result, subscribers: new Set() };
      this.turns.set(key, active);
    }
    return this.subscribe(key, active, requestId);
  }

  private recordFailure(id: string, cause: unknown): void {
    const error = cause instanceof DomainError ? cause : new DomainError('INTERNAL', 'Something went wrong in Delve.');
    try {
      markTutorJobFailed(this.db, id, error.code, error.message);
    } catch (persistenceError) {
      throw new AggregateError([cause, persistenceError], 'Could not record the tutor failure.', { cause: persistenceError });
    }
  }

  private active(job: SavedTutorJob) {
    const active = this.turns.get(lessonKey(job.request));
    return active?.id === job.id ? active : undefined;
  }

  jobs(): SavedTutorJob[] {
    return listTutorJobs(this.db).map(job => job.phase === 'running' && !this.active(job)
      ? { ...job, phase: 'failed', ...interrupted } : job);
  }

  wait(id: string): ReaderLesson | Promise<ReaderLesson> {
    const { job } = this.requireJob(id);
    if (job.phase === 'ready') return readLesson(this.db, job.request);
    if (job.phase === 'failed') throw new DomainError(job.code, job.message);
    const active = this.active(job);
    if (!active) throw new DomainError(interrupted.code, interrupted.message);
    return active.result;
  }

  retry(id: string, provider: TutorContract['tutor:retry']['request']['provider']): Promise<ReaderLesson> {
    const { job, token } = this.requireJob(id);
    if (job.phase !== 'running' || this.active(job)) throw new DomainError('TUTOR_BUSY', 'This tutor request is no longer interrupted.');
    if (provider !== job.request.provider) throw new DomainError('PROVIDER_CHANGED', 'The tutor changed. Review the request for the new tutor.');
    return this.run({ ...job.request, token, requestId: id });
  }

  dismiss(id: string): boolean {
    const saved = findTutorJob(this.db, id);
    return Boolean(saved && !this.active(saved.job) && removeTutorJob(this.db, id));
  }

  private requireJob(id: string) {
    const saved = findTutorJob(this.db, id);
    if (!saved) throw new DomainError('TUTOR_JOB_MISSING', 'This tutor request is no longer available.');
    assert.equal(saved.job.id, id);
    return saved;
  }

  private subscribe(key: string, active: ActiveTurn, id: string): Promise<ReaderLesson> {
    assert.ok(!active.subscribers.has(id));
    active.subscribers.add(id);
    return new Promise((resolve, reject) => {
      const leave = (): boolean => {
        if (!active.subscribers.delete(id)) return false;
        this.cancellations.delete(id);
        if (!active.subscribers.size && this.turns.get(key) === active) this.turns.delete(key);
        return true;
      };
      this.cancellations.set(id, () => {
        const error = new DomainError('TUTOR_CANCELLED', 'The tutor response was cancelled.');
        if (!this.closed && active.subscribers.size === 1) this.recordFailure(active.id, error);
        assert.ok(leave(), 'only active subscribers may cancel');
        if (!active.subscribers.size) active.controller.abort();
        reject(error);
      });
      active.result.then(value => { if (leave()) resolve(value); }, error => { if (leave()) reject(error); });
    });
  }

  cancel(requestId: string): boolean {
    const cancel = this.cancellations.get(requestId);
    cancel?.();
    return cancel !== undefined;
  }

  close(): void {
    this.closed = true;
    for (const cancel of this.cancellations.values()) cancel();
    assert.equal(this.turns.size, 0, 'closing the session releases every in-flight turn');
    assert.equal(this.cancellations.size, 0);
  }
}
