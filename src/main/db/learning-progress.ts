import assert from 'node:assert/strict';
import type { Depth } from '../../shared/domain';
import type { SavedCheckProgress, WorkspaceGraph, WorkspaceProgress } from '../../shared/graph';
import type { Db } from './connection';
import { lessonBinding } from './concept-binding';
import { boundedLessonBody, decodeSavedDocument, lessonOrderSql, lessonRevision as hashLesson, lessonScopeSql } from './lesson-selection';
import { masteryScope } from './mastery-scope';
import { conceptSnapshotIdSql, workspaceSnapshotIdSql } from './repository-snapshot';

// A lesson can be workspace-specific or portable, and snapshot-bound or unbound.
const latestByScopeSql = [':workspace', 'NULL'].flatMap(workspace => ['m.snapshot_id', 'NULL'].map(snapshot =>
  `SELECT * FROM (SELECT l.id, l.created_at, l.document_revision FROM lessons l
    WHERE l.concept_id = m.concept_id AND l.depth = m.depth AND l.workspace_id IS ${workspace}
      AND l.snapshot_id IS ${snapshot} AND l.document_revision IS NOT ''
      AND (l.provider <> 'demo' OR :demo = 1) ${lessonOrderSql} LIMIT 1)`,
)).join(' UNION ALL ');

const progressSql = `WITH workspace_snapshot AS MATERIALIZED (${workspaceSnapshotIdSql(':workspace')}),
  scoped_mastery AS MATERIALIZED (
    SELECT m.concept_id, coalesce(link.portable_concept_id, m.concept_id) AS canonical_id, m.depth, m.scope, m.revision, m.lesson_id,
      coalesce(m.check_attempts, json_extract(m.state, '$.attempts')) AS attempts,
      coalesce(m.check_streak, json_extract(m.state, '$.correctAnswers')) AS streak,
      coalesce((${conceptSnapshotIdSql(':workspace', 'coalesce(link.portable_concept_id, m.concept_id)')}), (SELECT * FROM workspace_snapshot)) AS snapshot_id
    FROM lesson_mastery m LEFT JOIN concept_identity_links link ON link.legacy_concept_id = m.concept_id
    WHERE m.workspace_id = :workspace AND m.depth = :depth AND m.state IS NOT NULL
  )
  SELECT m.concept_id AS conceptId, m.canonical_id AS canonicalId, m.scope, m.revision, m.lesson_id AS lessonId, m.attempts, m.streak,
    m.snapshot_id AS snapshotId, s.commit_sha AS snapshot,
    EXISTS (SELECT 1 FROM concept_identity_links link JOIN concepts c ON c.id = link.legacy_concept_id
      WHERE link.portable_concept_id = m.canonical_id AND c.workspace_id = :workspace) AS hasAlias, (
      SELECT json_array(id, document_revision) FROM (${latestByScopeSql})
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) AS selected FROM scoped_mastery m LEFT JOIN snapshots s ON s.id = m.snapshot_id`;

const legacySelectionSql = `SELECT l.id, l.document_revision, l.schema_version,
  CASE WHEN l.document_revision IS NULL THEN ${boundedLessonBody} END AS body
  FROM lessons l WHERE ${lessonScopeSql('?', '?', '?', '?', '?')} AND l.document_revision IS NOT ''
  ${lessonOrderSql}`;

type LessonIdentity = [id: number | null, revision: string | null];

function decodeIdentity(value: unknown): LessonIdentity {
  if (value === null) return [null, null];
  assert.ok(typeof value === 'string');
  const identity: unknown = JSON.parse(value);
  assert.ok(Array.isArray(identity) && identity.length === 2 && Number.isSafeInteger(identity[0]));
  assert.ok(identity[1] === null || (typeof identity[1] === 'string' && /^[a-f0-9]{64}$/.test(identity[1])));
  return identity as LessonIdentity;
}

function legacyIdentity(rows: Iterable<Record<string, unknown>>): LessonIdentity {
  for (const row of rows) {
    assert.ok(typeof row.id === 'number' && Number.isSafeInteger(row.id));
    if (typeof row.document_revision === 'string') {
      assert.match(row.document_revision, /^[a-f0-9]{64}$/);
      return [row.id, row.document_revision];
    }
    if (typeof row.body === 'string' && decodeSavedDocument(row.schema_version, row.body)) {
      return [row.id, hashLesson(row.id, row.body)];
    }
  }
  return [null, null];
}

export function readLearningProgress(db: Db, graph: WorkspaceGraph, depth: Depth): WorkspaceProgress {
  const { workspaceId, concepts, demo } = graph;
  const ids = new Set(concepts.map(concept => concept.id));
  const rows = db.prepare(progressSql).iterate({ workspace: workspaceId, depth, demo: Number(demo) });
  const checks: SavedCheckProgress[] = [];
  let legacy: ReturnType<Db['prepare']> | undefined;
  for (const row of rows) {
    const { conceptId, canonicalId, scope, revision, lessonId, streak, attempts, snapshotId, snapshot, hasAlias } = row;
    assert.ok(typeof conceptId === 'number' && typeof canonicalId === 'number' && typeof revision === 'string');
    if (!ids.has(canonicalId)) continue;
    assert.ok(snapshotId === null || typeof snapshotId === 'number');
    if (hasAlias && lessonBinding(db, { workspaceId, conceptId: canonicalId, depth, snapshotId }) !== conceptId) continue;
    assert.ok(snapshot === null || typeof snapshot === 'string');
    assert.equal(snapshotId === null, snapshot === null);
    const context = { workspaceId, conceptId, depth, snapshotId };
    let [selectedId, lessonRevision] = decodeIdentity(row.selected);
    if (selectedId !== null && lessonRevision === null) {
      legacy ??= db.prepare(legacySelectionSql);
      [selectedId, lessonRevision] = legacyIdentity(legacy.iterate(conceptId, depth, workspaceId, context.snapshotId, Number(demo)));
    }
    if (lessonId !== selectedId || scope !== masteryScope(context, lessonRevision)) continue;
    assert.ok(typeof attempts === 'number' && Number.isInteger(attempts) && attempts >= 0 && attempts <= 6);
    assert.ok(typeof streak === 'number' && Number.isInteger(streak) && streak >= 0 && streak <= attempts);
    checks.push({ conceptId: canonicalId, snapshot, lessonRevision, masteryRevision: revision, streak, attempted: attempts > 0 });
  }
  assert.ok(checks.length <= ids.size, 'only one committed check state per concept and depth');
  return { depth, checks };
}
