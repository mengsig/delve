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
  const aliases = db.prepare(`SELECT c.id FROM concept_identity_links link JOIN concepts c ON c.id = link.legacy_concept_id
    WHERE link.canonical_concept_id = ? AND c.workspace_id = ? ORDER BY c.id`).all(conceptId, workspaceId);
  if (!aliases.length) return { conceptId, invalidLatest: false };
  const ids = aliases.map(({ id }) => {
    assert.ok(typeof id === 'number' && id !== conceptId);
    return id;
  });
  const allowed = new Set([conceptId, ...ids]);
  const named = { concept: conceptId, workspace: workspaceId, depth, snapshot: snapshotId, demo: Number(demo) };
  const bound = `SELECT :concept UNION ALL SELECT link.legacy_concept_id FROM concept_identity_links link
    JOIN concepts c ON c.id = link.legacy_concept_id WHERE link.canonical_concept_id = :concept AND c.workspace_id = :workspace`;
  const rows = db.prepare(`SELECT l.concept_id, l.schema_version, l.document_revision,
    CASE WHEN l.document_revision IS NULL THEN ${boundedLessonBody} END AS body FROM lessons l
    WHERE ${lessonScopeSql(bound, ':depth', ':workspace', ':snapshot', ':demo')} ${lessonOrderSql}`).iterate(named);
  let unreadable: number | undefined;
  for (const row of rows) {
    assert.ok(typeof row.concept_id === 'number' && allowed.has(row.concept_id));
    if (row.document_revision || decodeSavedDocument(row.schema_version, row.body)) {
      return { conceptId: row.concept_id, invalidLatest: unreadable !== undefined };
    }
    unreadable ??= row.concept_id;
  }
  if (unreadable !== undefined) return { conceptId: unreadable, invalidLatest: true };
  const prior = db.prepare(`SELECT 1 FROM lesson_mastery WHERE workspace_id = ? AND concept_id = ? AND depth = ?
    AND scope = ? AND state IS NOT NULL AND lesson_id IS NULL`);
  const existing = [conceptId, ...ids].find(id => prior.get(workspaceId, id, depth, masteryScope({ ...address, conceptId: id }, null)));
  return { conceptId: existing ?? conceptId, invalidLatest: false };
}
