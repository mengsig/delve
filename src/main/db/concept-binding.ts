import assert from 'node:assert/strict';
import type { LessonAddress } from '../../shared/reader';
import type { Db } from './connection';
import { boundedLessonBody, decodeSavedDocument, lessonOrderSql, lessonScopeSql } from './lesson-selection';
import { masteryScope } from './mastery-scope';

type BindingScope = LessonAddress & { snapshotId: number | null; demo: boolean };
type LessonBinding = Pick<LessonAddress, 'conceptId'> & { invalidLatest: boolean };

export function lessonBinding(db: Db, address: BindingScope): LessonBinding {
  const { conceptId, workspaceId, depth, snapshotId, demo } = address;
  assert.ok(Number.isSafeInteger(conceptId) && conceptId > 0);
  const alias = db.prepare(`SELECT c.id FROM concept_identity_links link JOIN concepts c ON c.id = link.legacy_concept_id
    WHERE link.portable_concept_id = ? AND c.workspace_id = ? ORDER BY c.id LIMIT 1`).get(conceptId, workspaceId);
  if (!alias) return { conceptId, invalidLatest: false };
  assert.ok(typeof alias.id === 'number' && alias.id !== conceptId);

  const rows = db.prepare(`SELECT l.concept_id, l.schema_version, l.document_revision,
    CASE WHEN l.document_revision IS NULL THEN ${boundedLessonBody} END AS body FROM lessons l
    WHERE ${lessonScopeSql('?, ?', '?', '?', '?', '?')} ${lessonOrderSql}`)
    .iterate(conceptId, alias.id, depth, workspaceId, snapshotId, Number(demo));
  let unreadable: number | undefined;
  for (const row of rows) {
    assert.ok(row.concept_id === conceptId || row.concept_id === alias.id);
    if (row.document_revision || decodeSavedDocument(row.schema_version, row.body)) {
      return { conceptId: row.concept_id, invalidLatest: unreadable !== undefined };
    }
    unreadable ??= row.concept_id;
  }
  if (unreadable !== undefined) return { conceptId: unreadable, invalidLatest: true };
  const prior = db.prepare(`SELECT 1 FROM lesson_mastery WHERE workspace_id = ? AND concept_id = ? AND depth = ?
    AND scope = ? AND state IS NOT NULL AND lesson_id IS NULL`)
    .get(workspaceId, alias.id, depth, masteryScope({ ...address, conceptId: alias.id }, null));
  return { conceptId: prior ? alias.id : conceptId, invalidLatest: false };
}
