import assert from 'node:assert/strict';
import { DEPTHS } from '../../shared/domain';
import { coversDepth, demonstratedEvidence } from '../../shared/evidence-depth';
import type { WorkspaceGraph } from '../../shared/graph';
import type { Db } from './connection';
import { portableProofAtDepth } from './evidence';

export const changeApplicationReason = 'Review how this repository applies the concepts you already know.';

export function suggestedChanges(db: Db, workspaceId: string): NonNullable<WorkspaceGraph['changeSuggestions']> {
  const query = db.prepare(`SELECT g.kind, g.ref, g.reason, json_extract(g.result, '$.brief.title') AS title,
    json_extract(g.result, '$.brief.conceptId') AS briefId, target.id AS target, target.portable
    FROM repository_generations g LEFT JOIN concept_identity_links link ON link.legacy_concept_id = g.next_concept
    JOIN concepts target ON target.id = coalesce(link.portable_concept_id, g.next_concept)
    WHERE g.workspace_id = ? AND g.depth = ? AND g.kind <> 'baseline' ORDER BY g.last_used DESC LIMIT 1`);
  const suggestions: NonNullable<WorkspaceGraph['changeSuggestions']> = {};
  for (const depth of DEPTHS) {
    const row = query.get(workspaceId, depth);
    if (!row) continue;
    assert.ok(typeof row.target === 'number' && (row.portable === 0 || row.portable === 1));
    const mastered = row.portable === 1 && portableProofAtDepth(db, row.target, depth);
    if (row.target === row.briefId || mastered) {
      assert.ok(row.kind === 'pr' || row.kind === 'commit');
      assert.ok(typeof row.title === 'string' && typeof row.reason === 'string' && typeof row.ref === 'string');
      suggestions[depth] = { kind: row.kind, ref: row.ref, title: row.title, reason: mastered ? changeApplicationReason : row.reason };
    }
  }
  return suggestions;
}

type AtlasContent = Pick<WorkspaceGraph, 'concepts' | 'edges' | 'evidence'>;

function replacementSuggestion({ concepts, edges }: AtlasContent, target: WorkspaceGraph['concepts'][number], known: Set<number>) {
  const prerequisites = new Map<number, Set<number>>();
  for (const { conceptId, prerequisiteId } of edges) {
    assert.notEqual(conceptId, prerequisiteId);
    const required = prerequisites.get(conceptId) ?? new Set<number>();
    required.add(prerequisiteId);
    prerequisites.set(conceptId, required);
  }
  const missing = concepts.filter(c => !known.has(c.id));
  const ready = missing.filter(c => [...(prerequisites.get(c.id) ?? [])].every(id => known.has(id)));
  const usages = new Set(missing.filter(c => !c.portable && prerequisites.get(c.id)?.has(target.id)).map(c => c.id));
  const usage = ready.find(c => usages.has(c.id));
  if (usage) return { conceptId: usage.id, reason: `Apply what you already know about ${target.title} in this repository.` };
  const related = new Set(usages);
  const pending = [...usages];
  while (pending.length > 0) {
    const conceptId = pending.pop()!;
    for (const id of prerequisites.get(conceptId) ?? []) {
      if (known.has(id) || related.has(id)) continue;
      related.add(id);
      pending.push(id);
    }
  }
  assert.ok(target.portable && known.has(target.id));
  const next = ready.find(c => related.has(c.id)) ?? ready[0];
  return next && { conceptId: next.id, reason: `Continue with ${next.title} at the selected depth.` };
}

export function tutorSuggestions(db: Db, workspaceId: string, atlas: AtlasContent): NonNullable<WorkspaceGraph['suggestions']> {
  const latest = db.prepare(`WITH candidates AS (
    SELECT json_extract(m.body, '$.recommendation.targetId') AS target, json_extract(m.body, '$.recommendation.reason') AS reason,
      m.created_at AS at, m.id AS seq
    FROM conversations c JOIN messages m ON m.conversation_id = c.id
    JOIN lesson_mastery lm ON lm.workspace_id = c.workspace_id AND lm.concept_id = c.concept_id AND lm.depth = c.depth
    WHERE c.workspace_id = :workspace AND c.depth = :depth AND m.role = 'tutor' AND json_type(m.body, '$.recommendation') = 'object'
      AND json_extract(lm.state, '$.stage') IN ('understood', 'skipped')
      AND lm.revision = json_extract(m.body, '$.masteryRevision') AND lm.lesson_id IS c.lesson_id
    UNION ALL SELECT next_concept, reason, created_at, last_used FROM repository_generations WHERE workspace_id = :workspace AND depth = :depth
    ) SELECT wc.concept_id AS target, candidate.reason FROM candidates candidate
    LEFT JOIN concept_identity_links link ON link.legacy_concept_id = candidate.target
    JOIN workspace_concepts wc ON wc.concept_id = coalesce(link.portable_concept_id, candidate.target)
      AND wc.workspace_id = :workspace AND wc.on_atlas = 1
    ORDER BY candidate.at DESC, candidate.seq DESC LIMIT 1`);
  const suggestions: NonNullable<WorkspaceGraph['suggestions']> = {};
  const concepts = new Map(atlas.concepts.map(concept => [concept.id, concept]));
  const deepest = demonstratedEvidence(atlas.evidence);
  for (const depth of DEPTHS) {
    const row = latest.get({ workspace: workspaceId, depth });
    if (typeof row?.target !== 'number' || typeof row.reason !== 'string' || !row.reason.trim()) continue;
    const concept = concepts.get(row.target);
    if (!concept) continue;
    const proof = deepest.get(concept.id);
    if (concept.portable && proof && coversDepth(proof.depth, depth)) {
      const known = new Set(atlas.evidence.filter(e => e.status === 'demonstrated' &&
        (e.depth === depth || concepts.get(e.conceptId)?.portable && coversDepth(e.depth, depth))).map(e => e.conceptId));
      const replacement = replacementSuggestion(atlas, concept, known);
      if (replacement) suggestions[depth] = replacement;
    } else {
      suggestions[depth] = { conceptId: row.target, reason: row.reason };
    }
  }
  return suggestions;
}
