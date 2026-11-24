import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { changeIdentity, rememberChangeConcept } from './change-concept-identity';
import { canonicalConceptId, getConcept, getConceptByKey, type Concept } from './concepts';
import type { Db } from './connection';
import { compatibleDescriptions, portableAlias, scopedFingerprint } from './portable-identity';

const savedProposal = z.object({ concepts: z.array(z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,149}$/), title: z.string(), summary: z.string(), portable: z.boolean(),
})).max(60) });
const savedBrief = z.object({ brief: z.object({
  conceptId: z.int().positive(), base: z.string().nullish(), touched: z.array(z.object({ id: z.int().positive() })),
}) });
type Footprint = z.infer<typeof savedProposal>['concepts'][number];

function savedFootprint(db: Db, workspaceId: string, snapshotId: number, ids: Set<number>, input: Footprint): Concept | null {
  assert.ok(db.isTransaction && snapshotId > 0);
  assert.ok(input.key && workspaceId);
  const prefix = `ws/${workspaceId}/`;
  // Match the exact footprint key written by the released snapshot-scoped store.
  const hash = createHash('sha256').update(JSON.stringify(['concept', snapshotId, scopedFingerprint(input)])).digest('hex');
  const keys = [input.key, prefix + input.key, prefix + 'change/' + hash];
  const canonicalKey = input.portable && portableAlias(input.key, '');
  if (canonicalKey && canonicalKey !== input.key) keys.push(canonicalKey);
  const matches = new Map<number, Concept>();
  for (const key of keys) {
    const saved = getConceptByKey(db, key);
    if (!saved || !ids.has(saved.id) || !compatibleDescriptions(saved.summary, input.summary)) continue;
    const canonical = getConcept(db, canonicalConceptId(db, saved.id));
    assert.ok(canonical && (canonical.portable || canonical.workspaceId === workspaceId));
    if (compatibleDescriptions(canonical.summary, input.summary)) matches.set(canonical.id, canonical);
  }
  return matches.size === 1 ? matches.values().next().value! : null;
}

export function indexSavedChanges(db: Db): void {
  assert.ok(db.isTransaction);
  const rows = db.prepare(`SELECT g.workspace_id, g.kind, g.ref, g.snapshot_id, s.commit_sha, g.result, g.proposal, g.next_concept
    FROM repository_generations g JOIN snapshots s ON s.id = g.snapshot_id
    WHERE g.kind IN ('pr', 'commit') AND g.schema_version = 'delve.change/1' ORDER BY g.id`).iterate();
  const overviews = new Map<string, { workspaceId: string; change: string; ids: Set<number> }>();
  for (const { workspace_id: workspaceId, kind, ref, snapshot_id: snapshotId, commit_sha: head, result, proposal, next_concept } of rows) {
    assert.ok(typeof workspaceId === 'string' && typeof snapshotId === 'number');
    assert.ok(typeof ref === 'string' && typeof head === 'string' && (kind === 'pr' || kind === 'commit'));
    assert.ok(typeof result === 'string' && typeof proposal === 'string' && typeof next_concept === 'number');
    const saved = savedBrief.safeParse(JSON.parse(result));
    if (!saved.success) continue;
    const { brief } = saved.data;
    const change = changeIdentity(kind, kind === 'commit' ? head : ref, brief.base, head);
    const scope = { workspaceId, change };
    const scopeKey = workspaceId + '/' + change;
    const overview = getConcept(db, brief.conceptId);
    if (overview && overview.workspaceId === workspaceId && overview.key.startsWith(`ws/${workspaceId}/change/`)) {
      const entry = overviews.get(scopeKey) ?? { ...scope, ids: new Set<number>() };
      entry.ids.add(overview.id);
      overviews.set(scopeKey, entry);
    }
    const parsed = savedProposal.safeParse(JSON.parse(proposal));
    if (!parsed.success) continue;
    const ids = new Set([...brief.touched.map(({ id }) => id), next_concept]);
    ids.delete(brief.conceptId);
    for (const input of parsed.data.concepts) {
      const concept = savedFootprint(db, workspaceId, snapshotId, ids, input);
      if (concept) rememberChangeConcept(db, scope, concept, input);
    }
  }
  for (const { ids, ...scope } of overviews.values()) {
    if (ids.size !== 1) continue;
    const overview = getConcept(db, ids.values().next().value!);
    assert.ok(overview && !overview.portable);
    rememberChangeConcept(db, scope, overview);
  }
}
