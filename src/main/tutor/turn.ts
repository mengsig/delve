import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import type { ReaderMessage, TutorRequest } from '../../shared/reader';
import { transaction, type Db } from '../db/connection';
import { listEvidence, recordEvidenceInTransaction } from '../db/evidence';
import { saveLessonInTransaction } from '../db/lessons';
import { appendEntries } from '../reader/conversation';
import { storedLesson } from '../reader/stored-lesson';
import type { Document } from '../reader/document';
import { readLesson } from '../reader/ipc';
import { assessedEvidence } from './assessment';
import { prepareTurn, type PreparedTurn } from './prompt';
import { validateTurn, type Generate, type TutorReply } from './provider';

function saveOpening(db: Db, turn: PreparedTurn, lesson: Document) {
  const { context, cacheKey, cacheModel, request } = turn;
  const source = context.snapshot ?? (context.demo ? 'Field study · 01' : undefined);
  return saveLessonInTransaction(db, { ...context, snapshotId: context.snapshotId ?? undefined, cacheKey,
    model: cacheModel, provider: request.provider, schemaVersion: lesson.schema, body: { ...lesson, source } }).id;
}

function reuseOpening(db: Db, turn: PreparedTurn): boolean {
  if (turn.request.intent.kind !== 'teach') return false;
  if (turn.selected.invalidLatest) return false;
  if (turn.reused) return true;
  const cached = storedLesson(db, turn.context, turn.cacheKey);
  if (!cached.document || cached.invalidLatest) return false;
  const lesson = cached.document;
  if (turn.selected.id !== cached.id) transaction(db, () => saveOpening(db, turn, lesson));
  return true;
}

function saveAssessment(db: Db, turn: PreparedTurn, reply: TutorReply): string {
  const { context, response } = turn;
  if (!response) return '';
  const correct = response.correct ?? reply.assessment;
  assert.ok(typeof correct === 'boolean', 'a graded check must have a decision');
  const evidence = assessedEvidence(context, response, correct);
  const prior = listEvidence(db, context.conceptId).find(e => e.depth === context.depth);
  if (prior?.workspaceId && prior.workspaceId !== context.workspaceId) {
    return 'Your practice answer was recorded here. The original evidence stays in its workspace.';
  }
  if (prior?.status !== evidence.status || prior.note !== evidence.note || prior.snapshotId !== context.snapshotId) {
    recordEvidenceInTransaction(db, evidence);
  }
  return correct ? 'Connection learned. Your evidence is saved at ' + context.depth + ' depth.'
    : 'Your prediction is saved as partial evidence. You can revise it after the explanation.';
}

function commitReply(db: Db, turn: PreparedTurn, reply: TutorReply) {
  const { context, request, response } = turn;
  const tutor = { role: 'tutor' as const, observation: reply.observation ?? undefined, recommendation: reply.recommendation ?? undefined };
  if (request.intent.kind === 'teach') {
    const id = saveOpening(db, turn, reply.lesson);
    if (tutor.observation || tutor.recommendation) appendEntries(db, context, id, [{ ...tutor, text: '' }]);
    return;
  }
  const learnerText = request.intent.kind === 'ask' ? request.intent.text : response?.answer;
  assert.ok(learnerText, 'a follow-up must have a learner question or an answer');
  const learner: Pick<ReaderMessage, 'role' | 'text'> = { role: 'learner', text: learnerText };
  const text = saveAssessment(db, turn, reply);
  appendEntries(db, context, turn.selected.id, [learner, { ...tutor, text, lesson: reply.lesson }]);
}

export function checkedTurn(db: Db, request: TutorRequest, token: string) {
  const turn = prepareTurn(db, request);
  if (turn.preview.token !== token) throw new DomainError('STALE_PREVIEW', 'This lesson has changed. Preview the current request and retry.');
  return turn;
}

export async function executeTurn(db: Db, generate: Generate, turn: PreparedTurn, signal: AbortSignal) {
  if (reuseOpening(db, turn)) return readLesson(db, turn.context);
  const reply = await generate(turn, signal);
  if (signal.aborted) throw new DomainError('TUTOR_CANCELLED', 'The tutor response was cancelled.');
  validateTurn(turn, reply);
  transaction(db, () => {
    checkedTurn(db, turn.request, turn.preview.token);
    commitReply(db, turn, reply);
  });
  return readLesson(db, turn.context);
}
