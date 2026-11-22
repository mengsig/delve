import assert from 'node:assert/strict';
import type { LessonAddress } from '../../shared/reader';
import { DomainError } from '../../shared/errors';
import { learningSnapshot } from '../db/repository-snapshot';
import type { Db } from '../db/connection';
import { isDemoWorkspace } from '../db/demo';
import { lessonBinding } from '../db/concept-binding';
import { boundedLessonBody, decodeSavedDocument, lessonOrderSql, lessonRevision, lessonScopeSql } from '../db/lesson-selection';
import { createDemoLesson, type LessonContext } from './demo';
import type { Document } from './document';

export function lessonContext(db: Db, address: LessonAddress): LessonContext {
  const { workspaceId, conceptId } = address;
  const row = db.prepare(`SELECT c.id, c.key, c.title, c.summary, c.portable, w.kind FROM workspace_concepts wc
    JOIN concepts original ON original.id = wc.concept_id JOIN workspaces w ON w.id = wc.workspace_id
    LEFT JOIN concept_identity_links link ON link.legacy_concept_id = original.id
    JOIN concepts c ON c.id = coalesce(link.portable_concept_id, original.id)
    WHERE wc.workspace_id = ? AND wc.concept_id = ? AND (original.portable = 1 OR original.workspace_id = w.id)`).get(workspaceId, conceptId);
  if (!row) throw new DomainError('CONCEPT_NOT_FOUND', 'This workspace does not contain the selected concept.');
  assert.ok(typeof row.id === 'number' && row.id > 0);
  const snapshot = learningSnapshot(db, workspaceId, row.id);
  const snapshotId = snapshot?.id ?? null;
  const binding = lessonBinding(db, { ...address, conceptId: row.id, snapshotId });
  assert.ok(typeof row.key === 'string' && typeof row.title === 'string' && typeof row.summary === 'string');
  assert.ok(row.portable === 0 || row.portable === 1);
  assert.ok(!snapshot || (typeof snapshot.id === 'number' && typeof snapshot.commit_sha === 'string'));
  return {
    workspaceId, conceptId: binding, canonicalConceptId: row.id, depth: address.depth, key: row.key, title: row.title, summary: row.summary,
    portable: row.portable === 1, topic: row.kind === 'topic',
    demo: isDemoWorkspace(db, workspaceId),
    snapshotId,
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
  const rows = db.prepare(`SELECT l.id, l.schema_version, l.snapshot_id,
    CASE WHEN l.document_revision IS NOT '' THEN ${boundedLessonBody} END AS body
    FROM lessons l WHERE ${lessonScopeSql('?', '?', '?', '?', '?')} AND (? IS NULL OR l.cache_key = ?)
    ${lessonOrderSql}`).iterate(context.conceptId, context.depth, context.workspaceId, context.snapshotId, Number(context.demo), cacheKey, cacheKey);
  let invalidLatest = false;
  for (const row of rows) {
    const document = decodeSavedDocument(row.schema_version, row.body);
    if (document) {
      assert.ok(typeof row.id === 'number' && typeof row.body === 'string');
      assert.ok(row.snapshot_id === null || row.snapshot_id === context.snapshotId);
      const source = document.source ?? (row.snapshot_id === null ? null : context.snapshot);
      return { id: row.id, document, invalidLatest, revision: lessonRevision(row.id, row.body), source };
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
