import assert from 'node:assert/strict';
import type { LessonAddress } from '../../shared/reader';
import type { Db } from './connection';

function hasLessonHistory(id: string): string {
  return `EXISTS (SELECT 1 FROM lessons l WHERE l.concept_id = ${id} AND l.depth = :depth
      AND l.workspace_id = :workspaceId)
    OR EXISTS (SELECT 1 FROM conversations c LEFT JOIN lessons l ON l.id = c.lesson_id
      WHERE c.concept_id = ${id} AND c.workspace_id = :workspaceId AND coalesce(c.depth, l.depth) = :depth)
    OR EXISTS (SELECT 1 FROM lesson_mastery m
      WHERE m.concept_id = ${id} AND m.workspace_id = :workspaceId AND m.depth = :depth)`;
}

export function lessonBinding(db: Db, address: LessonAddress): number {
  assert.ok(Number.isSafeInteger(address.conceptId) && address.conceptId > 0);
  const row = db.prepare(`SELECT c.id FROM concept_identity_links link
    JOIN concepts c ON c.id = link.legacy_concept_id
    WHERE link.portable_concept_id = :conceptId AND c.workspace_id = :workspaceId
      AND NOT (${hasLessonHistory(':conceptId')})
      AND (${hasLessonHistory('c.id')})
    ORDER BY c.id LIMIT 1`).get({ conceptId: address.conceptId, workspaceId: address.workspaceId, depth: address.depth });
  if (!row) return address.conceptId;
  assert.ok(typeof row.id === 'number' && row.id !== address.conceptId);
  return row.id;
}
