import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { LessonAddress } from '../../shared/reader';
import { DomainError } from '../../shared/errors';
import { learningSnapshot } from '../db/repository-snapshot';
import type { Db } from '../db/connection';
import { isDemoWorkspace } from '../db/demo';
import { createDemoLesson, type LessonContext } from './demo';
import { documentSchema, type Document } from './document';

export function lessonContext(db: Db, address: LessonAddress): LessonContext {
  const { workspaceId, conceptId } = address;
  const row = db.prepare(`SELECT c.key, c.title, c.summary, w.kind FROM workspace_concepts wc
    JOIN concepts c ON c.id = wc.concept_id JOIN workspaces w ON w.id = wc.workspace_id
    WHERE wc.workspace_id = ? AND wc.concept_id = ? AND (c.portable = 1 OR c.workspace_id = w.id)`).get(workspaceId, conceptId);
  if (!row) throw new DomainError('CONCEPT_NOT_FOUND', 'This workspace does not contain the selected concept.');
  const snapshot = learningSnapshot(db, workspaceId, conceptId);
  assert.ok(typeof row.key === 'string' && typeof row.title === 'string' && typeof row.summary === 'string');
  assert.ok(!snapshot || (typeof snapshot.id === 'number' && typeof snapshot.commit_sha === 'string'));
  return {
    workspaceId, conceptId, depth: address.depth, key: row.key, title: row.title, summary: row.summary, topic: row.kind === 'topic',
    demo: isDemoWorkspace(db, workspaceId),
    snapshotId: snapshot ? Number(snapshot.id) : null,
    snapshot: snapshot ? String(snapshot.commit_sha) : null,
  };
}

export interface SelectedLesson {
  id: number | null;
  document: Document | null;
  revision: string | null;
  invalidLatest: boolean;
  source: string | null;
}

export function storedLesson(db: Db, context: LessonContext, cacheKey: string | null = null): SelectedLesson {
  const rows = db.prepare(`SELECT id, schema_version, snapshot_id, CASE WHEN length(CAST(body AS BLOB)) <= 524288 THEN body END AS body
    FROM lessons WHERE concept_id = ? AND depth = ? AND (workspace_id = ? OR workspace_id IS NULL)
    AND (snapshot_id IS NULL OR snapshot_id = ?) AND (provider <> 'demo' OR ? = 1) AND (? IS NULL OR cache_key = ?)
    ORDER BY created_at DESC, id DESC`).iterate(context.conceptId, context.depth, context.workspaceId, context.snapshotId, Number(context.demo), cacheKey, cacheKey);
  let invalidLatest = false;
  for (const row of rows) {
    if (row.schema_version === 'delve.lesson/1' && typeof row.body === 'string') {
      const result = documentSchema.safeParse(JSON.parse(row.body));
      if (result.success) {
        assert.ok(typeof row.id === 'number');
        const revision = createHash('sha256').update(String(row.id)).update(':').update(row.body).digest('hex');
        const source = result.data.source ?? (row.snapshot_id === null ? null : context.snapshot);
        return { id: row.id, document: result.data, invalidLatest, revision, source };
      }
    }
    invalidLatest = true;
  }
  return { id: null, document: null, invalidLatest, revision: null, source: context.snapshot };
}

export function selectLesson(db: Db, context: LessonContext, loadDemo = true): SelectedLesson {
  const stored = storedLesson(db, context);
  if (stored.document || stored.invalidLatest || !context.demo || !loadDemo) return stored;
  createDemoLesson(db, context);
  const saved = storedLesson(db, context);
  assert.ok(saved.document && saved.id !== null, 'the fixture document must survive a round trip');
  assert.ok(saved.revision && !saved.invalidLatest, 'a new fixture must be valid');
  return saved;
}
