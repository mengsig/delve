import assert from 'node:assert/strict';
import type { Db } from './connection';

interface Edge { conceptId: number; prerequisiteId: number }
type ProjectedEdge = Edge & { migrated: number };

function reaches(adjacency: Map<number, number[]>, start: number, target: number): boolean {
  assert.ok(Number.isSafeInteger(start) && start > 0);
  assert.ok(Number.isSafeInteger(target) && target > 0);
  const pending = [start];
  const seen = new Set<number>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const prerequisite of adjacency.get(id) ?? []) pending.push(prerequisite);
  }
  return false;
}

export function projectedEdges(db: Db, ids: Set<number>, workspaceId?: string): Edge[] {
  assert.ok(workspaceId === undefined || workspaceId.length > 0);
  if (!ids.size) return [];
  const scope = workspaceId === undefined ? '' : `JOIN workspace_concepts source ON source.concept_id = e.concept_id
    JOIN workspace_concepts target ON target.workspace_id = source.workspace_id AND target.concept_id = e.prerequisite_id`;
  const query = `SELECT concept.id AS conceptId, prerequisite.id AS prerequisiteId,
      min(a.legacy_concept_id IS NOT NULL OR b.legacy_concept_id IS NOT NULL) AS migrated
    FROM concept_edges e
    LEFT JOIN concept_identity_links a ON a.legacy_concept_id = e.concept_id
    LEFT JOIN concept_identity_links b ON b.legacy_concept_id = e.prerequisite_id
    JOIN concepts concept ON concept.id = coalesce(a.canonical_concept_id, e.concept_id)
    JOIN concepts prerequisite ON prerequisite.id = coalesce(b.canonical_concept_id, e.prerequisite_id)
    ${scope}
    WHERE (prerequisite.portable = 1 OR concept.workspace_id = prerequisite.workspace_id)
    ${workspaceId === undefined ? '' : 'AND source.workspace_id = ?'}
    GROUP BY conceptId, prerequisiteId ORDER BY migrated, conceptId, prerequisiteId`;
  const statement = db.prepare(query);
  const rows = (workspaceId === undefined ? statement.all() : statement.all(workspaceId)) as unknown as ProjectedEdge[];
  const adjacency = new Map<number, number[]>();
  const edges: Edge[] = [];
  for (const { conceptId, prerequisiteId, migrated } of rows) {
    assert.ok(migrated === 0 || migrated === 1);
    if (!ids.has(conceptId) || !ids.has(prerequisiteId)) continue;
    if (migrated && reaches(adjacency, prerequisiteId, conceptId)) continue;
    const next = adjacency.get(conceptId) ?? [];
    next.push(prerequisiteId);
    adjacency.set(conceptId, next);
    edges.push({ conceptId, prerequisiteId });
  }
  return edges.sort((a, b) => a.conceptId - b.conceptId || a.prerequisiteId - b.prerequisiteId);
}

export function canonicalEdges(db: Db): Edge[] {
  const rows = db.prepare(`SELECT id FROM concepts WHERE id NOT IN
    (SELECT legacy_concept_id FROM concept_identity_links)`).all();
  const ids = new Set(rows.map(row => {
    assert.ok(typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0);
    return row.id;
  }));
  assert.equal(ids.size, rows.length);
  return projectedEdges(db, ids);
}

export function edgeReachable(edges: Edge[], start: number, target: number): boolean {
  assert.ok(Number.isSafeInteger(start) && start > 0);
  assert.ok(Number.isSafeInteger(target) && target > 0);
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const next = adjacency.get(edge.conceptId) ?? [];
    next.push(edge.prerequisiteId);
    adjacency.set(edge.conceptId, next);
  }
  return reaches(adjacency, start, target);
}
