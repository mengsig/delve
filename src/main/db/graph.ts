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
import { suggestedChanges, tutorSuggestions } from './graph-suggestions';

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
  const visible = includeChangeLessons ? new Set(atlasIds(db, workspaceId, ids)) : ids;
  const suggestions = tutorSuggestions(db, workspaceId, includeChangeLessons ? {
    concepts: concepts.filter(concept => visible.has(concept.id)),
    evidence: evidence.filter(row => visible.has(row.conceptId)),
    edges: edges.filter(edge => visible.has(edge.conceptId) && visible.has(edge.prerequisiteId)),
  } : { concepts, evidence, edges });
  const baseline = db.prepare(`SELECT ref FROM repository_generations WHERE workspace_id = ? AND kind = 'baseline' ORDER BY last_used DESC LIMIT 1`).get(workspaceId);
  return {
    workspaceId, concepts, edges, evidence, snapshot: snapshot?.commit_sha ?? null, demo: isDemoWorkspace(db, workspaceId),
    ...(includeChangeLessons ? { atlasConceptIds: [...visible] } : {}),
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
