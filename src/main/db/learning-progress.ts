import assert from 'node:assert/strict';
import type { Depth } from '../../shared/domain';
import type { SavedCheckProgress, WorkspaceGraph, WorkspaceProgress } from '../../shared/graph';
import { lessonContext, storedLesson } from '../reader/stored-lesson';
import type { Db } from './connection';
import { masteryScope } from './mastery-scope';

export function readLearningProgress(db: Db, graph: WorkspaceGraph, depth: Depth): WorkspaceProgress {
  const { workspaceId, concepts } = graph;
  const ids = new Set(concepts.map(concept => concept.id));
  const rows = db.prepare(`SELECT concept_id AS conceptId, scope, revision, lesson_id AS lessonId,
    json_extract(state, '$.correctAnswers') AS streak, json_extract(state, '$.attempts') AS attempts
    FROM lesson_mastery WHERE workspace_id = ? AND depth = ? AND state IS NOT NULL`);
  const checks: SavedCheckProgress[] = [];
  for (const row of rows.iterate(workspaceId, depth)) {
    const { conceptId, scope, revision, lessonId, streak, attempts } = row;
    assert.ok(typeof conceptId === 'number' && typeof revision === 'string');
    if (!ids.has(conceptId)) continue;
    const context = lessonContext(db, { workspaceId, conceptId, depth });
    const selected = storedLesson(db, context);
    if (lessonId !== selected.id || scope !== masteryScope(context, selected.revision)) continue;
    assert.ok(typeof attempts === 'number' && Number.isInteger(attempts) && attempts >= 0 && attempts <= 6);
    assert.ok(typeof streak === 'number' && Number.isInteger(streak) && streak >= 0 && streak <= attempts);
    checks.push({ conceptId, snapshot: context.snapshot, lessonRevision: selected.revision, masteryRevision: revision,
      streak, attempted: attempts > 0 });
  }
  assert.ok(checks.length <= ids.size, 'only one committed check state per concept and depth');
  return { depth, checks };
}
