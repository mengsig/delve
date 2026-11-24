import assert from 'node:assert/strict';
import { z } from 'zod';
import type { SavedTutorJob, TutorContract, TutorJobEntry, UnreadableTutorJobIdentity } from '../../shared/reader';
import { transaction, type Db } from '../db/connection';
import { digest, tutorRequest } from './request';
import type { PreparedTurn } from './prompt';

const detail = tutorRequest.pick({ provider: true, intent: true, lessonId: true }).extend({
  title: z.string().min(1), submittedAnswer: z.string().optional(),
}).refine(({ intent, submittedAnswer }) => (submittedAnswer !== undefined) === (intent.kind === 'answer'), {
  path: ['submittedAnswer'],
  message: 'A submitted answer is required for answer requests and forbidden for other requests.',
});
const rowSchema = z.object({ id: z.uuid(), token: digest, detail: z.string(),
  workspace_id: tutorRequest.shape.workspaceId, concept_id: tutorRequest.shape.conceptId, depth: tutorRequest.shape.depth,
}).and(z.discriminatedUnion('phase', [
  z.object({ phase: z.enum(['running', 'ready']), code: z.null(), message: z.null() }),
  z.object({ phase: z.literal('failed'), code: z.string(), message: z.string() }),
]));

// Encode the raw primary key so a malformed UUID or non-text value can still be addressed.
export const unreadableJobIdentity = z.strictObject({
  jobKey: z.string().regex(/^(?:[0-9A-F]{2})*$/),
  version: z.string().regex(/^[0-9a-f]{32}$/),
});
const jobRows = `SELECT id, token, detail, workspace_id, CAST(concept_id AS TEXT) AS concept_id,
  depth, phase, code, message, hex(id) AS jobKey, version FROM tutor_jobs`;
const matchIdentity = 'hex(id) = ? AND version = ?';

function parseJob(raw: unknown): { token: string; job: SavedTutorJob } {
  const row = rowSchema.parse(raw);
  const { intent, provider, title, submittedAnswer, lessonId } = detail.parse(JSON.parse(row.detail));
  const request = { workspaceId: row.workspace_id, conceptId: row.concept_id, depth: row.depth, intent, provider, lessonId };
  const base = { id: row.id, title, request, submittedAnswer };
  const job: SavedTutorJob = row.phase === 'failed'
    ? { ...base, phase: row.phase, code: row.code, message: row.message }
    : { ...base, phase: row.phase };
  return { token: row.token, job };
}

export function storeTutorJob(db: Db, id: string, turn: PreparedTurn): void {
  const { request, context, preview, response } = turn;
  assert.equal(context.workspaceId, request.workspaceId);
  assert.equal(context.depth, request.depth);
  const body = detail.parse({ intent: request.intent, provider: request.provider, lessonId: request.lessonId, title: context.title, submittedAnswer: response?.answer });
  const result = db.prepare(`INSERT INTO tutor_jobs (id, workspace_id, concept_id, depth, token, detail, phase)
    VALUES (?, ?, ?, ?, ?, ?, 'running')
    ON CONFLICT (workspace_id, concept_id, depth) DO UPDATE SET
      id = excluded.id, token = excluded.token, detail = excluded.detail, phase = 'running', code = NULL, message = NULL`)
    .run(id, request.workspaceId, request.conceptId, request.depth, preview.token, JSON.stringify(body));
  assert.equal(result.changes, 1);
}

export function listTutorJobs(db: Db): TutorJobEntry[] {
  return db.prepare(`${jobRows} ORDER BY rowid`).all().map(row => readableJob(row) ?? {
    ...unreadableJobIdentity.parse({ jobKey: row.jobKey, version: row.version }),
    phase: 'unreadable', message: 'A saved tutor request could not be read and was skipped.',
  });
}

function readableJob(row: { concept_id?: unknown }): SavedTutorJob | undefined {
  const conceptId = typeof row.concept_id === 'string' ? Number(row.concept_id) : NaN;
  try {
    return parseJob({ ...row, concept_id: conceptId }).job;
  } catch (cause) {
    if (!(cause instanceof z.ZodError || cause instanceof SyntaxError)) throw cause;
  }
}

export function dismissUnreadableJob(
  db: Db, { jobKey, version }: UnreadableTutorJobIdentity, isActive: (id: string) => boolean,
): TutorContract['tutor:dismiss-unreadable']['response'] {
  return transaction(db, () => {
    const row = db.prepare(`${jobRows} WHERE ${matchIdentity}`).get(jobKey, version);
    if (!row) return 'changed';
    assert.equal(row.jobKey, jobKey);
    assert.equal(row.version, version);
    if (typeof row.id === 'string' && isActive(row.id)) return 'active';
    if (readableJob(row)) return 'changed';
    const result = db.prepare(`DELETE FROM tutor_jobs WHERE ${matchIdentity}`).run(jobKey, version);
    assert.equal(result.changes, 1, 'only the matching unreadable tutor job may be deleted');
    return 'dismissed';
  });
}

export function findTutorJob(db: Db, id: string) {
  const row = db.prepare('SELECT * FROM tutor_jobs WHERE id = ?').get(id);
  return row && parseJob(row);
}

export function markTutorJobReady(db: Db, id: string): void {
  assert.ok(db.isTransaction, 'a tutor job must commit with its lesson');
  const result = db.prepare("UPDATE tutor_jobs SET phase = 'ready' WHERE id = ? AND phase = 'running'").run(id);
  assert.equal(result.changes, 1, 'the committing tutor job must be active');
}

export function markTutorJobFailed(db: Db, id: string, code: string, message: string): void {
  assert.ok(code && message);
  const result = db.prepare("UPDATE tutor_jobs SET phase = 'failed', code = ?, message = ? WHERE id = ? AND phase = 'running'")
    .run(code, message, id);
  assert.ok(result.changes === 0 || result.changes === 1);
}

export function removeTutorJob(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM tutor_jobs WHERE id = ?').run(id).changes === 1;
}
