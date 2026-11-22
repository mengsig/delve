import assert from 'node:assert/strict';
import { DEPTHS } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import type { WorkspaceCoverage, WorkspaceGraph } from '../../shared/graph';
import { listWorkspaceConcepts } from './concepts';
import type { Db } from './connection';
import { isDemoWorkspace } from './demo';
import { listWorkspaceEvidence } from './evidence';
import { learningSnapshot } from './repository-snapshot';
import { getWorkspace } from './workspaces';
import { projectedEdges } from './migration-edges';

export function readWorkspaceGraph(db: Db, workspaceId: string, includeChangeLessons = false): WorkspaceGraph {
  const workspace = getWorkspace(db, workspaceId);
  if (!workspace) throw new DomainError('WORKSPACE_NOT_FOUND', 'That workspace no longer exists.');
  const concepts = listWorkspaceConcepts(db, workspaceId, includeChangeLessons)
    .sort((a, b) => a.id - b.id)
    .map(({ id, key, title, summary, portable }) => ({ id, key, title, summary, portable }));
  const ids = new Set(concepts.map(({ id }) => id));
  assert.equal(ids.size, concepts.length, 'workspace concept membership must be unique');
  const edges = projectedEdges(db, ids, workspaceId);
  const evidence = listWorkspaceEvidence(db, workspaceId, includeChangeLessons);
  assert.ok(evidence.every((row) => ids.has(row.conceptId)), 'evidence must be in the workspace graph');
  const snapshot = learningSnapshot(db, workspaceId);
  const changeSuggestions = suggestedChanges(db, workspaceId);
  const suggestions = tutorSuggestions(db, workspaceId, ids);
  const baseline = db.prepare(`SELECT ref FROM repository_generations WHERE workspace_id = ? AND kind = 'baseline' ORDER BY last_used DESC LIMIT 1`).get(workspaceId);
  return {
    workspaceId, concepts, edges, evidence, snapshot: snapshot?.commit_sha ?? null, demo: isDemoWorkspace(db, workspaceId),
    ...(includeChangeLessons ? { atlasConceptIds: atlasIds(db, workspaceId, ids) } : {}),
    ...(Object.keys(changeSuggestions).length ? { changeSuggestions } : {}),
    ...(Object.keys(suggestions).length ? { suggestions } : {}),
    ...(baseline ? { baselineCommit: String(baseline.ref) } : {}),
  };
}

function atlasIds(db: Db, workspaceId: string, ids: Set<number>): number[] {
  return db.prepare('SELECT concept_id AS id FROM workspace_concepts WHERE workspace_id = ? AND on_atlas = 1')
    .all(workspaceId).flatMap(({ id }) => {
      assert.ok(typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
      return ids.has(id) ? [id] : [];
    });
}

function suggestedChanges(db: Db, workspaceId: string): NonNullable<WorkspaceGraph['changeSuggestions']> {
  const query = db.prepare(`SELECT kind, ref, reason, json_extract(result, '$.brief.title') AS title,
    json_extract(result, '$.brief.conceptId') AS briefId, next_concept AS target FROM repository_generations
    WHERE workspace_id = ? AND depth = ? AND kind <> 'baseline' ORDER BY last_used DESC LIMIT 1`);
  const suggestions: NonNullable<WorkspaceGraph['changeSuggestions']> = {};
  for (const depth of DEPTHS) {
    const row = query.get(workspaceId, depth);
    if (row && row.target === row.briefId) {
      assert.ok(row.kind === 'pr' || row.kind === 'commit');
      assert.ok(typeof row.title === 'string' && typeof row.reason === 'string' && typeof row.ref === 'string');
      suggestions[depth] = { kind: row.kind, ref: row.ref, title: row.title, reason: row.reason };
    }
  }
  return suggestions;
}

function tutorSuggestions(db: Db, workspaceId: string, ids: Set<number>): NonNullable<WorkspaceGraph['suggestions']> {
  const latest = db.prepare(`SELECT target, reason FROM (SELECT json_extract(m.body, '$.recommendation.targetId') AS target,
    json_extract(m.body, '$.recommendation.reason') AS reason, m.created_at AS at, m.id AS seq
    FROM conversations c JOIN messages m ON m.conversation_id = c.id
    JOIN lesson_mastery lm ON lm.workspace_id = c.workspace_id AND lm.concept_id = c.concept_id AND lm.depth = c.depth
    WHERE c.workspace_id = ? AND c.depth = ? AND m.role = 'tutor' AND json_type(m.body, '$.recommendation') = 'object'
      AND json_extract(lm.state, '$.stage') IN ('understood', 'skipped')
      AND lm.revision = json_extract(m.body, '$.masteryRevision') AND lm.lesson_id IS c.lesson_id
    UNION ALL SELECT next_concept, reason, created_at, last_used FROM repository_generations WHERE workspace_id = ? AND depth = ?
    ) WHERE target IN (SELECT concept_id FROM workspace_concepts WHERE workspace_id = ? AND on_atlas = 1)
    ORDER BY at DESC, seq DESC LIMIT 1`);
  const suggestions: NonNullable<WorkspaceGraph['suggestions']> = {};
  for (const depth of DEPTHS) {
    const row = latest.get(workspaceId, depth, workspaceId, depth, workspaceId);
    if (typeof row?.target === 'number' && ids.has(row.target) && typeof row.reason === 'string' && row.reason.trim()) {
      suggestions[depth] = { conceptId: row.target, reason: row.reason };
    }
  }
  return suggestions;
}

interface CoverageRow {
  workspaceId: string;
  total: number;
  high: number;
  medium: number;
  low: number;
}

export function readWorkspaceCoverage(db: Db): WorkspaceCoverage[] {
  const rows = db.prepare(
    `SELECT w.id AS workspaceId, COUNT(DISTINCT c.id) AS total,
       COUNT(DISTINCT CASE WHEN e.depth = 'high' OR (c.portable = 1 AND e.depth IN ('medium', 'low')) THEN c.id END) AS high,
       COUNT(DISTINCT CASE WHEN e.depth = 'medium' OR (c.portable = 1 AND e.depth = 'low') THEN c.id END) AS medium,
       COUNT(DISTINCT CASE WHEN e.depth = 'low' THEN c.id END) AS low
     FROM workspaces w
     LEFT JOIN workspace_concepts wc ON wc.workspace_id = w.id AND wc.on_atlas = 1
     LEFT JOIN concepts c ON c.id = wc.concept_id AND (c.portable = 1 OR c.workspace_id = w.id)
     LEFT JOIN evidence e ON e.concept_id = c.id AND e.mastery_verified = 1
       AND (c.portable = 1 OR e.workspace_id = w.id)
     GROUP BY w.id ORDER BY w.rowid`,
  ).all() as unknown as CoverageRow[];
  return rows.map(({ workspaceId, total, high, medium, low }) => {
    const known = { high, medium, low };
    assert.ok(Number.isSafeInteger(total) && total >= 0, 'coverage must count a non-negative number of concepts');
    assert.ok(
      DEPTHS.every((depth) => Number.isSafeInteger(known[depth]) && known[depth] >= 0 && known[depth] <= total),
      'depth coverage must fit the map',
    );
    return { workspaceId, total, known };
  });
}
