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
  const query = `SELECT coalesce(a.canonical_concept_id, e.concept_id) AS conceptId,
      coalesce(b.canonical_concept_id, e.prerequisite_id) AS prerequisiteId,
      min(a.legacy_concept_id IS NOT NULL OR b.legacy_concept_id IS NOT NULL) AS migrated
    FROM concept_edges e
    LEFT JOIN concept_identity_links a ON a.legacy_concept_id = e.concept_id
    LEFT JOIN concept_identity_links b ON b.legacy_concept_id = e.prerequisite_id
    JOIN concepts prerequisite ON prerequisite.id = e.prerequisite_id
    LEFT JOIN concepts canonical ON canonical.id = a.canonical_concept_id
    ${scope}
    WHERE (a.legacy_concept_id IS NULL OR canonical.portable = 0 OR b.legacy_concept_id IS NOT NULL OR prerequisite.portable = 1)
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
