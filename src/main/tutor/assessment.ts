import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import type { TutorIntent } from '../../shared/reader';
import { listEvidence, recordEvidenceInTransaction } from '../db/evidence';
import type { Db } from '../db/connection';
import type { LessonContext } from '../reader/demo';
import { requireMasteryRevision, type Mastery } from './mastery';

export interface ResponseToCheck {
  prompt: string;
  answer: string;
  reference: string[];
  correct: boolean | null;
}

export function checkResponse(mastery: Mastery, intent: Extract<TutorIntent, { kind: 'answer' }>): ResponseToCheck {
  requireMasteryRevision(mastery, intent.revision, ['checking']);
  const check = mastery.check;
  assert.ok(check, 'checking always has one active question');
  if (check.options) {
    const index = intent.answer;
    if (typeof index !== 'number' || !Number.isInteger(index) || check.options[index] === undefined) {
      throw new DomainError('INVALID_OPTION', 'Choose one of the displayed answers.');
    }
    assert.ok(typeof check.expected === 'number');
    const expected = check.options[check.expected];
    assert.ok(expected, 'a validated choice has a reference answer');
    return { prompt: check.prompt, answer: check.options[index], reference: [expected], correct: index === check.expected };
  }
  if (typeof intent.answer !== 'string' || !intent.answer.trim()) throw new DomainError('INVALID_ANSWER', 'Write your answer first.');
  assert.ok(Array.isArray(check.expected) && check.expected.length > 0, 'free answers have reference examples');
  return { prompt: check.prompt, answer: intent.answer.trim(), reference: check.expected, correct: null };
}

export function saveCheckEvidence(db: Db, context: LessonContext, response: ResponseToCheck, demonstrated: boolean): void {
  assert.ok(db.isTransaction);
  assert.ok(response.prompt.trim() && response.answer.trim());
  const prior = listEvidence(db, context.conceptId).find(e => e.depth === context.depth);
  if (prior?.workspaceId && prior.workspaceId !== context.workspaceId && (prior.masteryVerified || !demonstrated)) return;
  if (prior?.status === 'demonstrated' && !demonstrated) return;
  recordEvidenceInTransaction(db, {
    workspaceId: context.workspaceId, conceptId: context.conceptId, snapshotId: context.snapshotId ?? undefined, depth: context.depth,
    status: demonstrated ? 'demonstrated' : 'partial', source: 'check', note: response.prompt + ' — ' + response.answer,
    masteryVerified: demonstrated,
  });
}
