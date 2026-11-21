import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import type { TutorIntent } from '../../shared/reader';
import type { EvidenceInput } from '../db/evidence';
import type { LessonContext } from '../reader/demo';
import type { SelectedLesson } from '../reader/stored-lesson';

export interface ResponseToCheck {
  prompt: string;
  answer: string;
  reference: string[];
  correct: boolean | null;
}

export function checkResponse(lesson: SelectedLesson, intent: Extract<TutorIntent, { kind: 'answer' }>): ResponseToCheck {
  const check = lesson.document?.blocks.find(block => block.type === 'check');
  if (!check || lesson.revision !== intent.revision) {
    throw new DomainError('LESSON_CHANGED', 'Reopen the lesson to try its current check.');
  }
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

export function assessedEvidence(context: LessonContext, response: ResponseToCheck, correct: boolean): EvidenceInput {
  return {
    workspaceId: context.workspaceId, conceptId: context.conceptId, snapshotId: context.snapshotId ?? undefined, depth: context.depth,
    status: correct ? 'demonstrated' : 'partial', source: 'check', note: response.prompt + ' — ' + response.answer,
  };
}
