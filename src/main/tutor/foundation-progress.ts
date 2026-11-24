import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { coversDepth } from '../../shared/evidence-depth';
import { DomainError } from '../../shared/errors';
import type { WorkspaceGraph } from '../../shared/graph';
import { plainConceptTitle } from '../../shared/plain-language';
import type { FoundationProgress, FoundationStep, ReaderContract } from '../../shared/reader';
import { transaction, type Db } from '../db/connection';
import { canonicalConceptId, type Concept } from '../db/concepts';
import { listEvidence } from '../db/evidence';
import { readWorkspaceGraph } from '../db/graph';
import { persistTutorPrerequisites } from '../db/tutor-prerequisites';
import type { LessonContext } from '../reader/demo';
import { checkResponse, saveCheckEvidence } from './assessment';
import { foundationSchema, type Foundation } from './foundation-content';
import { formatAnswerFeedback } from './language';
import { nextGrade } from './mastery';

const entriesSchema = z.array(z.strictObject({
  conceptId: z.int().positive(), content: foundationSchema, practised: z.literal(true).optional(),
})).max(4);
const progressSchema = z.object({
  entries: z.string().max(60_000), phase: z.enum(['probe', 'practice', 'done']), cursor: z.int().min(0).max(4),
}).transform(({ entries, ...progress }) => ({ ...progress, entries: entriesSchema.parse(JSON.parse(entries)) }));

type Entry = z.infer<typeof entriesSchema>[number];
type SavedProgress = z.infer<typeof progressSchema>;
type Decision = NonNullable<ReaderContract['reader:foundation']['request']['decision']>;
type FoundationScope = Pick<LessonContext, 'depth' | 'workspaceId' | 'canonicalConceptId'>;

function foundationMastery(db: Db, context: FoundationScope, conceptId: number) {
  const evidence = listEvidence(db, conceptId).filter(row => row.masteryVerified && row.status === 'demonstrated');
  if (evidence.some(row => coversDepth(row.depth, context.depth))) return 'known';
  return evidence.length ? 'shallower' : 'unlearned';
}

function answeredProbe(db: Db, conceptId: number): boolean {
  return db.prepare('SELECT 1 FROM evidence WHERE concept_id = ? AND probe_answered = 1 LIMIT 1').get(conceptId) !== undefined;
}

export function saveFoundations(db: Db, context: FoundationScope, lessonId: number, candidates: readonly Foundation[],
  bound?: ReadonlyMap<string, Concept>): void {
  assert.ok(db.isTransaction);
  assert.ok(lessonId > 0 && candidates.length <= 4);
  const source = new Map<string, Foundation>();
  for (const candidate of candidates) {
    if (!source.has(candidate.key)) source.set(candidate.key, candidate);
  }
  const resolved = persistTutorPrerequisites(db, context.workspaceId, context.canonicalConceptId, [...source.values()], bound);
  const entries = resolved.flatMap(({ concept, candidateKey }) => {
    const content = source.get(candidateKey);
    assert.ok(content, 'every resolved prerequisite comes from a foundation candidate');
    return foundationMastery(db, context, concept.id) === 'known' ? [] : [{ conceptId: concept.id, content }];
  });
  db.prepare(`INSERT INTO lesson_foundations (lesson_id, entries, phase) VALUES (?, ?, ?)
    ON CONFLICT (lesson_id) DO UPDATE SET entries = excluded.entries, phase = excluded.phase, cursor = 0`)
    .run(lessonId, JSON.stringify(entries), entries.length ? 'probe' : 'done');
}

function nextFoundation(db: Db, context: LessonContext, lessonId: number) {
  const row = db.prepare("SELECT entries, phase, cursor FROM lesson_foundations WHERE lesson_id = ? AND phase <> 'done'").get(lessonId);
  if (!row) return null;
  const saved = progressSchema.parse(row);
  const entries = saved.entries.map(entry => ({ ...entry, conceptId: canonicalConceptId(db, entry.conceptId) }));
  const mastery = entries.map(entry => foundationMastery(db, context, entry.conceptId));
  const isPrerequisite = (entry: Entry) => entry.conceptId !== context.canonicalConceptId;
  const nextProbe = (entry: Entry, index: number) =>
    isPrerequisite(entry) && index >= saved.cursor && mastery[index] === 'unlearned' && !answeredProbe(db, entry.conceptId);
  const nextPractice = (entry: Entry, index: number) =>
    isPrerequisite(entry) && (saved.phase === 'probe' || index >= saved.cursor) && mastery[index] !== 'known';
  const probeIndex = saved.phase === 'probe' ? entries.findIndex(nextProbe) : -1;
  const phase = probeIndex >= 0 ? 'probe' : 'practice';
  const index = phase === 'probe' ? probeIndex : entries.findIndex(nextPractice);
  if (index < 0) return null;
  const entry = entries[index];
  assert.ok(entry && (phase !== 'probe' || !answeredProbe(db, entry.conceptId)));
  assert.ok(index < saved.entries.length && saved.entries.length <= 4);
  const { title, why, summary, explanation } = entry.content;
  const check = entry.content[phase];
  const revision = createHash('sha256').update(JSON.stringify([lessonId, phase, index, entry])).digest('hex');
  const common = { revision, title, why, position: index + 1, total: saved.entries.length, prompt: check.prompt, options: check.options };
  const step: FoundationStep = phase === 'probe' ? { ...common, phase } : {
    ...common, phase, explanation: explanation ?? summary, goDeeper: mastery[index] === 'shallower',
  };
  return { step, entry, check, index, entries };
}

export function readFoundation(db: Db, context: LessonContext, lessonId: number | null): FoundationStep | null {
  return lessonId === null ? null : nextFoundation(db, context, lessonId)?.step ?? null;
}

function advance(db: Db, lessonId: number, phase: SavedProgress['phase'], cursor: number, entries: Entry[]): void {
  assert.ok(db.isTransaction);
  assert.ok(Number.isInteger(cursor) && cursor >= 0 && cursor <= entries.length);
  const result = db.prepare('UPDATE lesson_foundations SET phase = ?, cursor = ?, entries = ? WHERE lesson_id = ?')
    .run(phase, cursor, JSON.stringify(entries), lessonId);
  assert.equal(result.changes, 1, 'only the active foundation plan advances');
}

export function foundationRecap(db: Db, context: FoundationScope, lessonId: number | null, graph?: WorkspaceGraph) {
  const row = lessonId === null ? undefined : db.prepare('SELECT entries, phase, cursor FROM lesson_foundations WHERE lesson_id = ?').get(lessonId);
  const known: string[] = [];
  const reviewed: string[] = [];
  if (!row && !graph) return { known, reviewed };
  const entries = row ? progressSchema.parse(row).entries : [];
  const workspace = graph ?? readWorkspaceGraph(db, context.workspaceId, true);
  assert.equal(workspace.workspaceId, context.workspaceId);
  const prerequisites = new Set(workspace.edges.filter(edge => edge.conceptId === context.canonicalConceptId)
    .map(edge => edge.prerequisiteId));
  const practised = new Set(entries.filter(entry => entry.practised).map(entry => canonicalConceptId(db, entry.conceptId)));
  const covering = new Set(workspace.evidence.filter(row =>
    row.status === 'demonstrated' && coversDepth(row.depth, context.depth)).map(row => row.conceptId));
  for (const concept of workspace.concepts) {
    if (!prerequisites.has(concept.id)) continue;
    const title = context.depth === 'high' ? plainConceptTitle(concept.title) : concept.title;
    if (practised.has(concept.id)) reviewed.push(title);
    else if (covering.has(concept.id)) known.push(title);
  }
  assert.ok(known.length + reviewed.length <= prerequisites.size);
  return { known, reviewed };
}

export function foundationIntroduction(db: Db, context: FoundationScope, lessonId: number | null): string | undefined {
  const { known, reviewed } = foundationRecap(db, context, lessonId);
  if (reviewed[0]) return `This builds on ${reviewed[0]}, which you just went through.`;
  if (known[0]) return `This builds on ${known[0]}, which you already know.`;
}

function finishFoundations(db: Db, context: LessonContext, lessonId: number, entries: Entry[]): FoundationProgress {
  advance(db, lessonId, 'done', 0, entries);
  const introduction = foundationIntroduction(db, context, lessonId);
  return introduction ? { step: null, foundationIntroduction: introduction } : { step: null };
}

function gradeFoundation(db: Db, context: LessonContext, current: NonNullable<ReturnType<typeof nextFoundation>>, answer: number) {
  const { step, entry, check } = current;
  const active = { stage: 'checking' as const, check, revision: step.revision };
  const response = checkResponse(active, { kind: 'answer', revision: step.revision, answer });
  const grade = nextGrade({ ...active, attempts: 0, correctAnswers: 0, applied: false, maxAttempts: 1, requiredCorrectAnswers: 1 },
    response.correct);
  assert.equal(response.reference.length, 1);
  assert.notEqual(entry.conceptId, context.canonicalConceptId);
  saveCheckEvidence(db, { ...context, canonicalConceptId: entry.conceptId }, response, grade.stage === 'understood');
  if (step.phase === 'probe') {
    const result = db.prepare('UPDATE evidence SET probe_answered = 1 WHERE concept_id = ? AND depth = ?')
      .run(entry.conceptId, context.depth);
    assert.equal(result.changes, 1, 'each answered probe must have a corresponding evidence record');
  }
  return formatAnswerFeedback(response.correct, 'The answer is “' + response.reference[0] + '”.');
}

export function answerFoundation(db: Db, context: LessonContext, lessonId: number | null, decision: Decision): FoundationProgress {
  return transaction(db, () => {
    const current = lessonId === null ? null : nextFoundation(db, context, lessonId);
    if (lessonId === null || !current || current.step.revision !== decision.revision) {
      throw new DomainError('LESSON_CHANGED', 'The foundation question changed. Reopen the lesson to see the current question.');
    }
    const { phase } = current.step;
    const { index, entries, entry } = current;
    if (decision.answer === null) return finishFoundations(db, context, lessonId, entries);
    const feedback = gradeFoundation(db, context, current, decision.answer);
    if (phase === 'practice') entries[index] = { ...entry, practised: true };
    advance(db, lessonId, phase, index + 1, entries);
    const step = readFoundation(db, context, lessonId);
    return step ? { step, feedback } : { ...finishFoundations(db, context, lessonId, entries), feedback };
  });
}
