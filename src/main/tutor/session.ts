import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import type { ReaderLesson, TutorContract } from '../../shared/reader';
import type { Db } from '../db/connection';
import { createGenerator, type Generate } from './provider';
import { checkedTurn, executeTurn } from './turn';

interface ActiveTurn {
  token: string;
  controller: AbortController;
  result: Promise<ReaderLesson>;
  subscribers: Set<string>;
}

export class TutorSession {
  private closed = false;
  private turns = new Map<string, ActiveTurn>();
  private cancellations = new Map<string, () => void>();
  constructor(private db: Db, private generate: Generate = createGenerator()) {}

  run(request: TutorContract['tutor:run']['request']): Promise<ReaderLesson> {
    if (this.closed) throw new DomainError('TUTOR_CLOSED', 'The tutor is closing.');
    const { requestId, token } = request;
    if (this.cancellations.has(requestId)) throw new DomainError('DUPLICATE_REQUEST', 'That request is already running.');
    const turn = checkedTurn(this.db, request, token);
    const key = [request.workspaceId, request.conceptId, request.depth].join('/');
    let active = this.turns.get(key);
    if (active && active.token !== token) throw new DomainError('TUTOR_BUSY', 'Finish or cancel the current tutor response first.');
    if (!active) {
      const controller = new AbortController();
      const result = executeTurn(this.db, this.generate, turn, controller.signal);
      active = { token, controller, result, subscribers: new Set() };
      this.turns.set(key, active);
    }
    return this.subscribe(key, active, requestId);
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
        assert.ok(leave(), 'only active subscribers may cancel');
        if (!active.subscribers.size) active.controller.abort();
        reject(new DomainError('TUTOR_CANCELLED', 'The tutor response was cancelled.'));
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
