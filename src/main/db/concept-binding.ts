import assert from 'node:assert/strict';
import type { LessonAddress } from '../../shared/reader';
import type { Db } from './connection';
import { boundedLessonBody, decodeSavedDocument, lessonOrderSql } from './lesson-selection';
import { masteryScope } from './mastery-scope';

type BindingScope = LessonAddress & { snapshotId: number | null };

export function lessonBinding(db: Db, address: BindingScope): number {
  const { conceptId, workspaceId, depth, snapshotId } = address;
  assert.ok(Number.isSafeInteger(conceptId) && conceptId > 0);
  const alias = db.prepare(`SELECT c.id FROM concept_identity_links link JOIN concepts c ON c.id = link.legacy_concept_id
    WHERE link.portable_concept_id = ? AND c.workspace_id = ? ORDER BY c.id LIMIT 1`).get(conceptId, workspaceId);
  if (!alias) return conceptId;
  assert.ok(typeof alias.id === 'number' && alias.id !== conceptId);

  const rows = db.prepare(`SELECT l.concept_id, l.schema_version, l.document_revision,
    CASE WHEN l.document_revision IS NULL THEN ${boundedLessonBody} END AS body FROM lessons l
    WHERE l.concept_id IN (?, ?) AND l.workspace_id = ? AND l.depth = ?
    AND (l.snapshot_id IS NULL OR l.snapshot_id = ?) AND l.document_revision IS NOT ''
    AND l.provider <> 'demo' ${lessonOrderSql}`).iterate(conceptId, alias.id, workspaceId, depth, snapshotId);
  for (const row of rows) {
    assert.ok(row.concept_id === conceptId || row.concept_id === alias.id);
    if (row.document_revision || decodeSavedDocument(row.schema_version, row.body)) return row.concept_id;
  }
  const prior = db.prepare(`SELECT 1 FROM lesson_mastery WHERE workspace_id = ? AND concept_id = ? AND depth = ?
    AND scope = ? AND state IS NOT NULL AND lesson_id IS NULL`)
    .get(workspaceId, alias.id, depth, masteryScope({ ...address, conceptId: alias.id }, null));
  return prior ? alias.id : conceptId;
}
