import assert from 'node:assert/strict';
import { z } from 'zod';
import type { SavedTutorJob, TutorJobEntry } from '../../shared/reader';
import type { Db } from '../db/connection';
import { digest, tutorRequest } from './request';
import type { PreparedTurn } from './prompt';

const detail = tutorRequest.pick({ provider: true, intent: true }).extend({
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

function parseJob(raw: unknown): { token: string; job: SavedTutorJob } {
  const row = rowSchema.parse(raw);
  const { intent, provider, title, submittedAnswer } = detail.parse(JSON.parse(row.detail));
  const request = { workspaceId: row.workspace_id, conceptId: row.concept_id, depth: row.depth, intent, provider };
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
  const body = detail.parse({ intent: request.intent, provider: request.provider, title: context.title, submittedAnswer: response?.answer });
  const result = db.prepare(`INSERT INTO tutor_jobs (id, workspace_id, concept_id, depth, token, detail, phase)
    VALUES (?, ?, ?, ?, ?, ?, 'running')
    ON CONFLICT (workspace_id, concept_id, depth) DO UPDATE SET
      id = excluded.id, token = excluded.token, detail = excluded.detail, phase = 'running', code = NULL, message = NULL`)
    .run(id, request.workspaceId, request.conceptId, request.depth, preview.token, JSON.stringify(body));
  assert.equal(result.changes, 1);
}

export function listTutorJobs(db: Db): TutorJobEntry[] {
  const rows = db.prepare('SELECT *, CAST(rowid AS TEXT) AS row_key FROM tutor_jobs ORDER BY rowid').all();
  return rows.map(row => {
    try {
      return parseJob(row).job;
    } catch (cause) {
      if (!(cause instanceof z.ZodError || cause instanceof SyntaxError)) throw cause;
      const rowKey = row.row_key;
      assert.ok(typeof rowKey === 'string' && rowKey.length > 0, 'every stored tutor job must have a row key');
      return { phase: 'unreadable', rowKey,
        message: 'A saved tutor request could not be read and was skipped.' };
    }
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
