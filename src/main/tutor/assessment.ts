import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import type { TutorIntent } from '../../shared/reader';
import { listEvidence, recordEvidenceInTransaction } from '../db/evidence';
import type { Db } from '../db/connection';
import type { LessonContext } from '../reader/demo';
import { needsCheckAdaptation, requireMasteryRevision, type Mastery } from './mastery';

export interface ResponseToCheck {
  prompt: string;
  selectedIndex: number;
  answer: string;
  reasoning?: string;
  reference: string[];
  correct: boolean;
}

export function checkResponse(mastery: Mastery, intent: Extract<TutorIntent, { kind: 'answer' }>): ResponseToCheck {
  requireMasteryRevision(mastery, intent.revision, ['checking']);
  const check = mastery.check;
  assert.ok(check, 'checking always has one active question');
  if (needsCheckAdaptation(check)) {
    throw new DomainError('ADAPTATION_REQUIRED', 'Prepare the saved check as four choices before answering.');
  }
  assert.ok(check.options && typeof check.expected === 'number');
  const selectedIndex = intent.answer;
  if (typeof selectedIndex !== 'number' || !Number.isInteger(selectedIndex) || check.options[selectedIndex] === undefined) {
    throw new DomainError('INVALID_OPTION', 'Choose one of the displayed answers.');
  }
  const expected = check.options[check.expected];
  assert.ok(expected !== undefined, 'a validated choice has a reference answer');
  return { prompt: check.prompt, selectedIndex, answer: check.options[selectedIndex], reasoning: intent.reasoning?.trim() ? intent.reasoning : undefined,
    reference: [expected], correct: selectedIndex === check.expected };
}

export function saveCheckEvidence(db: Db, context: LessonContext, response: ResponseToCheck, demonstrated: boolean): void {
  assert.ok(db.isTransaction);
  assert.ok(response.prompt.length > 0 && response.answer.length > 0);
  const prior = listEvidence(db, context.conceptId).find(e => e.depth === context.depth);
  if (prior?.workspaceId && prior.workspaceId !== context.workspaceId && (prior.masteryVerified || !demonstrated)) return;
  if (prior?.status === 'demonstrated' && !demonstrated) return;
  recordEvidenceInTransaction(db, {
    workspaceId: context.workspaceId, conceptId: context.conceptId, snapshotId: context.snapshotId ?? undefined, depth: context.depth,
    status: demonstrated ? 'demonstrated' : 'partial', source: 'check', note: response.prompt + ' — ' + response.answer,
    masteryVerified: demonstrated,
  });
}
