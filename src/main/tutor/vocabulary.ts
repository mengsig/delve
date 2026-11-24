import assert from 'node:assert/strict';
import type { Db } from '../db/connection';
import type { WorkspaceGraph } from '../../shared/graph';
import { foundationIdentity } from './foundation-content';

export function knownFoundations(db: Db, graph?: WorkspaceGraph, target?: { id: number; portable: boolean }) {
  assert.ok(!graph || target);
  assert.ok(!target || graph && target.id > 0 && graph.workspaceId);
  const prerequisites = graph?.edges.filter(edge => edge.conceptId === target?.id).map(edge => edge.prerequisiteId) ?? [];
  const workspace = graph && !target?.portable ? graph.workspaceId : null;
  const prefix = workspace ? `ws/${workspace}/` : '';
  const rows = db.prepare(`SELECT CASE WHEN c.portable = 1 THEN c.key ELSE substr(c.key, length(:prefix) + 1) END AS key,
    substr(c.title, 1, 100) AS title, c.summary
    FROM concepts c
    WHERE (c.portable = 1 OR (c.workspace_id = :workspace AND substr(c.key, 1, length(:prefix)) = :prefix))
      AND c.id IS NOT :target AND length(trim(c.summary)) BETWEEN 1 AND 600
      AND c.key NOT LIKE 'Demo:%'
      AND NOT EXISTS (SELECT 1 FROM concept_identity_links l WHERE l.legacy_concept_id = c.id)
    ORDER BY c.id IN (SELECT value FROM json_each(:prerequisites)) DESC,
      EXISTS (SELECT 1 FROM evidence e WHERE e.concept_id = c.id AND e.mastery_verified = 1) DESC,
      c.portable, c.id`).iterate({ workspace, prefix, target: target?.id ?? null, prerequisites: JSON.stringify(prerequisites) });
  const seen = new Set<string>();
  const vocabulary = [];
  for (const row of rows) {
    const identity = foundationIdentity.safeParse(row);
    if (!identity.success || seen.has(identity.data.key)) continue;
    seen.add(identity.data.key);
    vocabulary.push(identity.data);
    if (vocabulary.length === 40) break;
  }
  assert.equal(vocabulary.length, seen.size);
  return vocabulary;
}
