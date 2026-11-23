import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEPTHS, type Depth } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import { nowIso, transaction, type Db } from './connection';
import { boundedLessonBody, decodeSavedDocument, lessonRevision } from './lesson-selection';
import { resolveScope } from './scope';

const SCHEMA_VERSION = /^delve\.lesson\/\d+$/;
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;
export const TUTOR_GENERATION = 'four-choice/1';

export interface CacheKeyParts {
  schemaVersion: string;
  generation?: string;
  conceptKey: string;
  depth: Depth;
  provider: string;
  model: string;
  /** What the lesson was generated from: a commit, a diff hash, or a topic revision. */
  sourceRef: string;
}

/** Deterministic cache key over everything that changes a generated lesson (R14). */
export function lessonCacheKey(parts: CacheKeyParts): string {
  assert.ok(SCHEMA_VERSION.test(parts.schemaVersion), `bad schema version ${parts.schemaVersion}`);
  assert.ok((DEPTHS as readonly string[]).includes(parts.depth), `bad depth ${parts.depth}`);
  const fields = [parts.schemaVersion, parts.conceptKey, parts.depth, parts.provider, parts.model, parts.sourceRef];
  if (parts.generation !== undefined) fields.push(parts.generation);
  assert.ok(fields.every((field) => field.length > 0), 'every cache key part is required');
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/** Binds a workspace to a commit; returns the existing binding when already recorded. */
export function bindSnapshot(db: Db, workspaceId: string, commitSha: string): number {
  if (!COMMIT_SHA.test(commitSha)) throw new DomainError('INVALID_SNAPSHOT', `"${commitSha}" is not a commit id.`);
  const sha = commitSha.toLowerCase();
  db.prepare('INSERT OR IGNORE INTO snapshots (workspace_id, commit_sha, created_at) VALUES (?, ?, ?)').run(workspaceId, sha, nowIso());
  const row = db.prepare('SELECT id FROM snapshots WHERE workspace_id = ? AND commit_sha = ?').get(workspaceId, sha) as
    | { id: number }
    | undefined;
  assert.ok(row && Number.isInteger(row.id), 'snapshot binding must exist after insert');
  return row.id;
}

export interface LessonInput {
  cacheKey: string;
  schemaVersion: string;
  conceptId: number;
  workspaceId?: string;
  snapshotId?: number;
  depth: Depth;
  provider: string;
  model: string;
  /** An already validated lesson document. */
  body: unknown;
}

export interface StoredLesson extends Omit<LessonInput, 'workspaceId' | 'snapshotId'> {
  id: number;
  workspaceId: string | null;
  snapshotId: number | null;
  createdAt: string;
}

interface LessonRow {
  id: number;
  cache_key: string;
  schema_version: string;
  concept_id: number;
  workspace_id: string | null;
  snapshot_id: number | null;
  depth: string;
  provider: string;
  model: string;
  body: string;
  created_at: string;
}

function toLesson(row: LessonRow): StoredLesson {
  assert.ok((DEPTHS as readonly string[]).includes(row.depth), `unknown depth ${row.depth}`);
  assert.ok(SCHEMA_VERSION.test(row.schema_version), `unknown schema ${row.schema_version}`);
  return {
    id: row.id,
    cacheKey: row.cache_key,
    schemaVersion: row.schema_version,
    conceptId: row.concept_id,
    workspaceId: row.workspace_id,
    snapshotId: row.snapshot_id,
    depth: row.depth as Depth,
    provider: row.provider,
    model: row.model,
    body: JSON.parse(row.body) as unknown,
    createdAt: row.created_at,
  };
}

export function getLessonByCacheKey(db: Db, cacheKey: string): StoredLesson | null {
  const row = db.prepare('SELECT * FROM lessons WHERE cache_key = ?').get(cacheKey) as LessonRow | undefined;
  return row ? toLesson(row) : null;
}

/** Stores a validated lesson; a new body for the same cache key replaces the old one. */
export function saveLesson(db: Db, input: LessonInput): StoredLesson {
  return transaction(db, () => saveLessonInTransaction(db, input));
}

export function saveLessonInTransaction(db: Db, input: LessonInput): StoredLesson {
  assert.ok(db.isTransaction, 'lesson writes must be atomic');
  if (!SCHEMA_VERSION.test(input.schemaVersion)) throw new DomainError('INVALID_LESSON', `Unknown lesson schema "${input.schemaVersion}".`);
  if (!(DEPTHS as readonly string[]).includes(input.depth)) throw new DomainError('INVALID_LESSON', `Unknown depth "${input.depth}".`);
  const body = JSON.stringify(input.body);
  assert.ok(typeof body === 'string' && body.length > 0, 'lesson body must serialize to JSON');
  const scope = resolveScope(db, input.conceptId, input.workspaceId, input.snapshotId);
  const createdAt = nextLessonTime(db, input);
  const valid = validateReplacement(db, input, body);
  const saved = db.prepare(
    `INSERT INTO lessons (cache_key, schema_version, concept_id, workspace_id, snapshot_id, depth, provider, model, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (cache_key) DO UPDATE SET body = excluded.body, created_at = excluded.created_at
     RETURNING *`,
  ).get(
    input.cacheKey,
    input.schemaVersion,
    input.conceptId,
    scope.workspaceId,
    scope.snapshotId,
    input.depth,
    input.provider,
    input.model,
    body,
    createdAt,
  ) as LessonRow | undefined;
  assert.ok(saved && Number.isSafeInteger(saved.id), 'the cache entry must have a lesson ID');
  const result = db.prepare('UPDATE lessons SET document_revision = ? WHERE id = ?')
    .run(valid ? lessonRevision(saved.id, body) : '', saved.id);
  assert.equal(result.changes, 1);
  return toLesson(saved);
}

function validateReplacement(db: Db, input: LessonInput, body: string): boolean {
  const existing = db.prepare('SELECT id, schema_version, document_revision FROM lessons WHERE cache_key = ?')
    .get(input.cacheKey);
  assert.ok(!existing || typeof existing.schema_version === 'string');
  if (decodeSavedDocument(existing?.schema_version ?? input.schemaVersion, body)) return true;
  if (!existing || existing.document_revision === '') return false;
  assert.ok(typeof existing.id === 'number' && Number.isSafeInteger(existing.id));
  if (existing.document_revision === null) {
    const previous = db.prepare(`SELECT ${boundedLessonBody} AS body FROM lessons l WHERE l.id = ?`).get(existing.id);
    assert.ok(previous, 'the previous cache entry must exist within the transaction');
    if (!decodeSavedDocument(existing.schema_version, previous.body)) return false;
  }
  throw new DomainError('INVALID_LESSON', 'The replacement lesson is unreadable. The saved lesson was preserved.');
}

// A cache hit can replace an older row in the same millisecond as a newer revision.
function nextLessonTime(db: Db, input: LessonInput): string {
  const now = nowIso();
  const row = db.prepare(`WITH canonical(id) AS (
    SELECT coalesce((SELECT portable_concept_id FROM concept_identity_links WHERE legacy_concept_id = :concept), :concept)
  ) SELECT max(created_at) AS latest FROM lessons WHERE depth = :depth AND concept_id IN (
    SELECT id FROM canonical UNION ALL SELECT legacy_concept_id FROM concept_identity_links
    WHERE portable_concept_id = (SELECT id FROM canonical)
  )`).get({ concept: input.conceptId, depth: input.depth });
  assert.ok(row && (row.latest === null || typeof row.latest === 'string'));
  if (row.latest === null || row.latest < now) return now;
  const previous = Date.parse(row.latest);
  assert.ok(Number.isFinite(previous), 'a saved lesson must have a readable creation time');
  return new Date(previous + 1).toISOString();
}
