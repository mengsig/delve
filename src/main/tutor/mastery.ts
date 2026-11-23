import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../shared/errors';
import { masteryLimits } from '../../shared/mastery-limits';
import type { ReaderMastery } from '../../shared/reader';
import type { Db } from '../db/connection';
import { listEvidence } from '../db/evidence';
import { readMasteryRow, writeMasteryRow } from '../db/mastery';
import { masteryScope } from '../db/mastery-scope';
import type { LessonContext } from '../reader/demo';
import { documentSchema, freshCheckSchema, type Document } from '../reader/document';
import type { SelectedLesson } from '../reader/stored-lesson';

export type MasteryCheck = Extract<Document['blocks'][number], { type: 'check' }>;
export { masteryLimits };
const cycleSchema = z.object({
  stage: z.enum(['teaching', 'checking', 'review', 'understood', 'skipped']),
  check: z.unknown(),
  attempts: z.int().min(0).max(6),
  correctAnswers: z.int().min(0).max(6),
  applied: z.boolean(),
  cycle: z.int().nonnegative(),
  prompts: z.array(z.string()).max(512),
});
type Cycle = Omit<z.infer<typeof cycleSchema>, 'check'> & { check: MasteryCheck | null };
export type Mastery = Cycle & { scope: string; revision: string | null; lessonId: number | null;
  requiredCorrectAnswers: number; maxAttempts: number };

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const newRevision = () => randomBytes(32).toString('hex');
const questionWords = (prompt: string) => prompt.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function repeatsQuestion(current: string[], previous: string): boolean {
  const prior = questionWords(previous);
  if (current.join('') === prior.join('')) return true;
  if (current.filter(word => /\d/.test(word)).join(' ') !== prior.filter(word => /\d/.test(word)).join(' ')) return false;
  const words = new Set(current);
  const earlierWords = new Set(prior);
  const shared = [...words].filter(word => earlierWords.has(word)).length;
  return shared >= 6 && shared / (words.size + earlierWords.size - shared) >= 0.9;
}

export const hasVerifiedMastery = (db: Db, context: LessonContext) => listEvidence(db, context.conceptId)
  .some(e => e.depth === context.depth && e.masteryVerified && e.workspaceId !== null);

export function checkIn(document: Document | null): MasteryCheck | null {
  return document?.blocks.find(block => block.type === 'check') ?? null;
}

export const needsCheckAdaptation = (check: MasteryCheck) => !check.options || check.options.length > 4;
const isApplication = (check: MasteryCheck) => !check.options || freshCheckSchema.safeParse(check).success;

function decodeCycle(raw: string): Cycle {
  const fields = cycleSchema.parse(JSON.parse(raw));
  const check = fields.check === null ? null : checkIn(documentSchema.parse({ schema: 'delve.lesson/1', blocks: [fields.check] }));
  assert.equal(fields.stage === 'checking', check !== null, 'only checking may carry an active question');
  assert.ok(fields.correctAnswers <= fields.attempts && (!fields.applied || fields.correctAnswers > 0));
  return { ...fields, check };
}

export function loadMastery(db: Db, context: LessonContext, selected: SelectedLesson, inherited: boolean): Mastery {
  const [requiredCorrectAnswers, maxAttempts] = masteryLimits[context.depth];
  const scope = masteryScope(context, selected.revision);
  const saved = readMasteryRow(db, context, scope);
  const check = checkIn(selected.document);
  const stage = inherited ? 'understood' : check ? 'checking' : 'teaching';
  const initial: Cycle = { stage, check: inherited ? null : check, attempts: 0, correctAnswers: 0,
    applied: false, cycle: 0, prompts: check ? [check.prompt] : [] };
  const state = saved?.state ? decodeCycle(saved.state) : initial;
  assert.ok(state.attempts <= maxAttempts && (state.stage !== 'review' || state.attempts === maxAttempts));
  assert.ok(state.stage !== 'checking' || state.attempts < maxAttempts);
  assert.ok(state.stage !== 'understood' || inherited || state.applied && state.correctAnswers >= requiredCorrectAnswers);
  const revision = saved?.revision ?? (selected.revision || inherited ? hash([scope, stage]) : null);
  return { ...state, scope, revision, lessonId: selected.id, requiredCorrectAnswers, maxAttempts };
}

export function publicMastery(mastery: Mastery): ReaderMastery {
  const { stage, revision, check, attempts, maxAttempts, correctAnswers, requiredCorrectAnswers } = mastery;
  assert.equal(stage === 'checking', check !== null);
  assert.ok(correctAnswers <= attempts && attempts <= maxAttempts);
  return { stage, revision, attempts, maxAttempts, correctAnswers, requiredCorrectAnswers,
    appliedPassed: mastery.applied, needsAdaptation: check !== null && needsCheckAdaptation(check),
    activeCheck: check && { kind: isApplication(check) ? 'applied' : 'recognition', prompt: check.prompt,
      ...(check.options ? { options: check.options } : {}) } };
}

export const canRecommend = ({ stage }: Pick<Mastery, 'stage'>) => stage === 'understood' || stage === 'skipped';

export function requireMasteryRevision(mastery: Mastery, revision: string, stages: readonly ReaderMastery['stage'][]): void {
  if (mastery.revision !== revision || !stages.includes(mastery.stage)) {
    throw new DomainError('LESSON_CHANGED', 'The question changed. Review the current check.');
  }
}

type Grade = Pick<Cycle, 'attempts' | 'correctAnswers' | 'applied'> & { stage: 'checking' | 'review' | 'understood' };

export function nextGrade(mastery: Mastery, correct: boolean): Grade {
  assert.ok(mastery.stage === 'checking' && mastery.check, 'only an active check can be graded');
  assert.ok(mastery.attempts < mastery.maxAttempts, 'an exhausted cycle must be reviewed first');
  const attempts = mastery.attempts + 1;
  const correctAnswers = correct ? mastery.correctAnswers + 1 : 0;
  const applied = correct && (mastery.applied || isApplication(mastery.check));
  const stage = applied && correctAnswers >= mastery.requiredCorrectAnswers ? 'understood'
    : attempts === mastery.maxAttempts ? 'review' : 'checking';
  return { stage, attempts, correctAnswers, applied };
}

export function assertFreshCheck(mastery: Mastery, check: MasteryCheck): void {
  const words = questionWords(check.prompt);
  if (mastery.prompts.length >= 512) {
    throw new DomainError('INVALID_TUTOR_REPLY', 'This lesson has exhausted its fresh questions. Reset its learning record to start again.');
  }
  if (!freshCheckSchema.safeParse(check).success || !words.length || mastery.prompts.some(previous => repeatsQuestion(words, previous))) {
    throw new DomainError('INVALID_TUTOR_REPLY', 'The tutor must provide a fresh applied check with four distinct choices and a valid answer key. Retry this turn.');
  }
}

export function saveMastery(db: Db, address: LessonContext, prior: Mastery, update: Partial<Cycle>): string {
  const { stage, check, attempts, correctAnswers, applied, cycle, prompts } = { ...prior, ...update };
  assert.equal(stage === 'checking', check !== null);
  assert.ok(correctAnswers <= attempts && attempts <= prior.maxAttempts);
  const seen = check && check !== prior.check ? [...prompts, check.prompt] : prompts;
  const revision = newRevision();
  writeMasteryRow(db, address, { scope: prior.scope, revision, lessonId: prior.lessonId,
    state: JSON.stringify({ stage, check, attempts, correctAnswers, applied, cycle, prompts: seen }) });
  return revision;
}
