import assert from 'node:assert/strict';
import type { Depth } from '../../shared/domain';
import type { LessonAddress } from '../../shared/reader';
import type { Db } from './connection';

export function readMasteryRow(db: Db, address: LessonAddress, scope: string) {
  const row = db.prepare(`SELECT revision, state FROM lesson_mastery
    WHERE workspace_id = ? AND concept_id = ? AND depth = ? AND scope = ?`)
    .get(address.workspaceId, address.conceptId, address.depth, scope);
  if (!row) return null;
  assert.ok(typeof row.revision === 'string' && /^[a-f0-9]{64}$/.test(row.revision));
  assert.ok(row.state === null || typeof row.state === 'string');
  return { revision: row.revision, state: row.state };
}

export function writeMasteryRow(db: Db, address: LessonAddress,
  row: { scope: string; revision: string; state: string; lessonId: number | null }): void {
  assert.ok(db.isTransaction, 'mastery updates must commit with the corresponding turn');
  assert.ok(row.scope !== row.revision && /^[a-f0-9]{64}$/.test(row.revision));
  const result = db.prepare(`INSERT INTO lesson_mastery (workspace_id, concept_id, depth, scope, revision, state, lesson_id)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, concept_id, depth) DO UPDATE SET
    scope = excluded.scope, revision = excluded.revision, state = excluded.state, lesson_id = excluded.lesson_id`)
    .run(address.workspaceId, address.conceptId, address.depth, row.scope, row.revision, row.state, row.lessonId);
  assert.equal(result.changes, 1);
}

export function resetMastery(db: Db, conceptId: number, depth: Depth | undefined, workspaceId: string | undefined): void {
  assert.ok(db.isTransaction, 'mastery and evidence resets must commit together');
  const result = db.prepare(`UPDATE lesson_mastery SET state = NULL, revision = lower(hex(randomblob(32)))
    WHERE (concept_id = :id OR concept_id IN (SELECT legacy_concept_id FROM concept_identity_links WHERE portable_concept_id = :id))
      AND (:depth IS NULL OR depth = :depth) AND (:workspace IS NULL OR workspace_id = :workspace)`)
    .run({ id: conceptId, depth: depth ?? null, workspace: workspaceId ?? null });
  assert.ok(Number.isSafeInteger(result.changes) && Number(result.changes) >= 0);
}
