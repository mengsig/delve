import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import type { TutorRequest } from '../../shared/reader';
import { transaction, type Db } from '../db/connection';
import { saveLessonInTransaction } from '../db/lessons';
import { appendEntries } from '../reader/conversation';
import { storedLesson } from '../reader/stored-lesson';
import { freshCheckSchema, type Document } from '../reader/document';
import { readLesson } from '../reader/ipc';
import { saveCheckEvidence } from './assessment';
import { checkIn, loadMastery, nextGrade, saveMastery } from './mastery';
import { prepareTurn, type PreparedTurn } from './prompt';
import { validateTurn, type Generate, type TutorReply } from './provider';

function saveOpening(db: Db, turn: PreparedTurn, lesson: Document) {
  const { context, cacheKey, cacheModel, request } = turn;
  const source = context.snapshot ?? (context.demo ? 'Field study · 01' : undefined);
  return saveLessonInTransaction(db, { ...context, snapshotId: context.snapshotId ?? undefined, cacheKey,
    model: cacheModel, provider: request.provider, schemaVersion: lesson.schema, body: { ...lesson, source } }).id;
}

function reuseOpening(db: Db, turn: PreparedTurn): boolean {
  if (turn.request.intent.kind !== 'teach' || turn.selected.invalidLatest) return false;
  if (turn.reused) return true;
  const cached = storedLesson(db, turn.context, turn.cacheKey);
  if (!cached.document || cached.invalidLatest || !freshCheckSchema.safeParse(checkIn(cached.document)).success) return false;
  const lesson = cached.document;
  if (turn.selected.id !== cached.id) transaction(db, () => saveOpening(db, turn, lesson));
  return true;
}

function gradeFeedback(correct: boolean, stage: 'understood' | 'review' | 'checking') {
  const verdict = correct ? 'Correct.' : 'That answer was incorrect.';
  if (stage === 'understood') return verdict + ' You demonstrated understanding at this depth.';
  if (stage === 'review') return verdict + ' This round is complete. Start a fresh practice round when you are ready.';
  return verdict + ' Try a fresh example to show how the rule applies.';
}

function commitAnswer(db: Db, turn: PreparedTurn, reply: TutorReply): void {
  const { context, mastery, response } = turn;
  assert.ok(response, 'a check answer has a trusted local grade');
  assert.equal(reply.assessment, response.correct);
  const next = nextGrade(mastery, response.correct);
  const revision = saveMastery(db, context, mastery, { ...next, check: checkIn(reply.lesson) });
  saveCheckEvidence(db, context, response, next.stage === 'understood');
  appendEntries(db, context, turn.selected.id, [
    { role: 'learner', text: !response.reasoning
      ? response.answer : response.answer + '\n\nReasoning: ' + response.reasoning },
    { role: 'tutor', text: gradeFeedback(response.correct, next.stage), correct: response.correct, lesson: reply.lesson, reasoningFeedback: reply.reasoningFeedback,
      observation: reply.observation ?? undefined, recommendation: reply.recommendation ?? undefined,
      masteryRevision: reply.recommendation ? revision : undefined },
  ]);
}

function commitReply(db: Db, turn: PreparedTurn, reply: TutorReply): void {
  const { context, selected, mastery, request: { intent } } = turn;
  const tutor = { role: 'tutor' as const, observation: reply.observation ?? undefined,
    recommendation: reply.recommendation ?? undefined, masteryRevision: reply.recommendation ? mastery.revision ?? undefined : undefined };
  if (intent.kind === 'answer') return commitAnswer(db, turn, reply);
  if (intent.kind === 'adapt') {
    const check = checkIn(reply.lesson);
    assert.ok(check && mastery.check);
    assert.equal(mastery.revision, intent.revision);
    saveMastery(db, context, mastery, { check });
    return;
  }
  if (intent.kind === 'teach' || intent.kind === 'review' && !selected.document) {
    const id = saveOpening(db, turn, reply.lesson);
    const current = loadMastery(db, context, storedLesson(db, context), false);
    assert.equal(current.lessonId, id);
    assert.ok(checkIn(reply.lesson));
    if (current.scope !== mastery.scope || intent.kind === 'review') {
      saveMastery(db, context, current, { stage: 'checking', check: checkIn(reply.lesson),
        cycle: intent.kind === 'review' ? mastery.cycle + 1 : 0 });
    }
    if (tutor.observation) appendEntries(db, context, id, [{ ...tutor, text: '' }]);
    return;
  }
  if (intent.kind === 'review') {
    saveMastery(db, context, mastery, { stage: 'checking', check: checkIn(reply.lesson), attempts: 0,
      correctAnswers: 0, applied: false, cycle: mastery.cycle + 1 });
    appendEntries(db, context, selected.id, [{ ...tutor, text: 'A fresh review round is ready.', lesson: reply.lesson }]);
    return;
  }
  assert.equal(intent.kind, 'ask');
  appendEntries(db, context, selected.id, [{ role: 'learner', text: intent.text }, { ...tutor, text: '', lesson: reply.lesson }]);
}

export function checkedTurn(db: Db, request: TutorRequest, token: string) {
  const turn = prepareTurn(db, request);
  if (turn.preview.token !== token) throw new DomainError('STALE_PREVIEW', 'This lesson has changed. Preview the current request and retry.');
  return turn;
}

export async function executeTurn(db: Db, generate: Generate, turn: PreparedTurn, signal: AbortSignal) {
  if (reuseOpening(db, turn)) return readLesson(db, turn.context);
  const output = await generate(turn, signal);
  if (signal.aborted) throw new DomainError('TUTOR_CANCELLED', 'The tutor response was cancelled.');
  const reply = validateTurn(turn, output);
  transaction(db, () => {
    checkedTurn(db, turn.request, turn.preview.token);
    commitReply(db, turn, reply);
  });
  return readLesson(db, turn.context);
}
