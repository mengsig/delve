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

function pinnedLessonBinding(db: Db, { lessonId, workspaceId, depth }: LessonAddress, canonicalConceptId: number) {
  assert.ok(lessonId && Number.isSafeInteger(lessonId));
  assert.ok(canonicalConceptId > 0);
  const row = db.prepare(`SELECT l.concept_id, l.snapshot_id, s.commit_sha FROM lessons l
    LEFT JOIN snapshots s ON s.id = l.snapshot_id AND s.workspace_id = l.workspace_id
    WHERE l.id = :id AND l.workspace_id = :workspace AND l.depth = :depth AND
    (l.concept_id = :canonical OR l.concept_id IN (
      SELECT legacy_concept_id FROM concept_identity_links WHERE canonical_concept_id = :canonical
    )) AND (l.snapshot_id IS NULL OR s.id IS NOT NULL)`)
    .get({ id: lessonId, workspace: workspaceId, depth, canonical: canonicalConceptId });
  if (!row) throw new DomainError('LESSON_CHANGED', 'Reopen the change to see the current lesson.');
  assert.ok(typeof row.concept_id === 'number');
  assert.ok(row.snapshot_id === null || typeof row.snapshot_id === 'number' && typeof row.commit_sha === 'string');
  const snapshot = row.snapshot_id === null ? null : { id: row.snapshot_id, commit_sha: String(row.commit_sha) };
  return { conceptId: row.concept_id, snapshot, invalidLatest: false };
}

export function lessonContext(db: Db, address: LessonAddress): LessonContext {
  const { workspaceId, conceptId } = address;
  const row = db.prepare(`SELECT c.id, c.key, c.title, c.summary, c.portable, w.kind FROM workspace_concepts wc
    JOIN concepts original ON original.id = wc.concept_id JOIN workspaces w ON w.id = wc.workspace_id
    LEFT JOIN concept_identity_links link ON link.legacy_concept_id = original.id
    JOIN concepts c ON c.id = coalesce(link.canonical_concept_id, original.id)
    WHERE wc.workspace_id = ? AND wc.concept_id = ? AND (original.portable = 1 OR original.workspace_id = w.id)`).get(workspaceId, conceptId);
  if (!row) throw new DomainError('CONCEPT_NOT_FOUND', 'This workspace does not contain the selected concept.');
  assert.ok(typeof row.id === 'number' && row.id > 0);
  const demo = isDemoWorkspace(db, workspaceId);
  const pinned = address.lessonId === undefined ? null : pinnedLessonBinding(db, address, row.id);
  const snapshot = pinned ? pinned.snapshot : learningSnapshot(db, workspaceId, row.id);
  const snapshotId = snapshot?.id ?? null;
  const { conceptId: boundConceptId, invalidLatest } = pinned ?? lessonBinding(db, { ...address, conceptId: row.id, snapshotId, demo });
  assert.ok(typeof row.key === 'string' && typeof row.title === 'string' && typeof row.summary === 'string');
  assert.ok(row.portable === 0 || row.portable === 1);
  assert.ok(!snapshot || (typeof snapshot.id === 'number' && typeof snapshot.commit_sha === 'string'));
  return {
    conceptId: boundConceptId, invalidLatest, workspaceId, lessonId: address.lessonId, canonicalConceptId: row.id,
    depth: address.depth, key: row.key, title: row.title, summary: row.summary,
    portable: row.portable === 1, topic: row.kind === 'topic', demo,
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
  let invalidLatest = cacheKey === null && context.invalidLatest;
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

export function requestedLesson(db: Db, context: LessonContext, loadDemo = true): SelectedLesson {
  const { lessonId } = context;
  if (lessonId === undefined) return selectLesson(db, context, loadDemo);
  const row = db.prepare(`SELECT l.schema_version, l.concept_id, l.snapshot_id,
    CASE WHEN l.document_revision IS NOT '' THEN ${boundedLessonBody} END AS body
    FROM lessons l WHERE l.id = ?`).get(lessonId);
  assert.ok(row && row.concept_id === context.conceptId);
  assert.equal(row.snapshot_id, context.snapshotId);
  const document = decodeSavedDocument(row.schema_version, row.body);
  if (!document || typeof row.body !== 'string') throw new DomainError('LESSON_CHANGED', 'The saved change lesson cannot be read.');
  return { id: lessonId, document, revision: lessonRevision(lessonId, row.body), invalidLatest: false,
    source: document.source ?? (row.snapshot_id === null ? null : context.snapshot) };
}
