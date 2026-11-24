import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { changeIdentity, rememberChangeConcept } from './change-concept-identity';
import { canonicalConceptId, getConcept, getConceptByKey, type Concept } from './concepts';
import type { Db } from './connection';
import { findPortableConcept } from './portable-concepts';
import { baselineConceptFingerprint, compatibleScopedMeanings, portableAlias, releasedScopedFingerprint } from './portable-identity';

const savedProposal = z.object({ concepts: z.array(z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,149}$/), title: z.string().trim().min(1), summary: z.string().trim().min(1), portable: z.boolean(),
})).max(60) });
const savedBrief = z.object({ brief: z.object({
  conceptId: z.int().positive(), base: z.string().nullish(), touched: z.array(z.object({ id: z.int().positive() })),
}) });
type Footprint = z.infer<typeof savedProposal>['concepts'][number];

function savedFootprint(db: Db, workspaceId: string, snapshotId: number, ids: Set<number>, input: Footprint): Concept | null {
  assert.ok(db.isTransaction && snapshotId > 0);
  assert.ok(input.key && workspaceId);
  const prefix = `ws/${workspaceId}/`;
  const candidates = [getConceptByKey(db, prefix + input.key), input.portable ? findPortableConcept(db, input) : null];
  const label = portableAlias(input.key, input.title);
  // Some released portable fingerprints used a recognized title in place of the key.
  if (!input.portable || label === null || label === portableAlias(input.key, '')) {
    const hash = createHash('sha256').update(JSON.stringify(['concept', snapshotId, releasedScopedFingerprint(input)])).digest('hex');
    candidates.push(getConceptByKey(db, prefix + 'change/' + hash));
  }
  const membership = db.prepare('SELECT 1 FROM snapshot_concepts WHERE snapshot_id = ? AND concept_id = ?');
  const attributed = new Map<number, Concept>();
  const matches = new Map<number, Concept>();
  for (const saved of candidates) {
    if (!saved || !compatibleScopedMeanings(input, { ...saved, key: saved.portable ? saved.key : input.key })) continue;
    const canonical = getConcept(db, canonicalConceptId(db, saved.id));
    assert.ok(canonical && (canonical.portable || canonical.workspaceId === workspaceId));
    if (!compatibleScopedMeanings(input, { ...canonical, key: canonical.portable ? canonical.key : input.key })) continue;
    if (ids.has(saved.id) || ids.has(canonical.id)) attributed.set(canonical.id, canonical);
    if (membership.get(snapshotId, saved.id)) matches.set(canonical.id, canonical);
  }
  const candidatesForChange = attributed.size ? attributed : matches;
  return candidatesForChange.size === 1 ? candidatesForChange.values().next().value! : null;
}

function indexSavedChanges(db: Db): void {
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

function indexSavedBaselines(db: Db): void {
  assert.ok(db.isTransaction);
  db.exec(`CREATE TEMP TABLE migration_baseline_keys (workspace_id TEXT, concept_id INTEGER, fingerprint TEXT,
    PRIMARY KEY (workspace_id, concept_id, fingerprint));`);
  const generations = db.prepare(`SELECT workspace_id, snapshot_id, proposal FROM repository_generations
    WHERE kind = 'baseline' AND schema_version = 'delve.map/1'`);
  const scoped = db.prepare(`SELECT c.id, c.title, c.summary FROM scoped_proposal_concepts s
    JOIN concepts c ON c.id = s.concept_id
    JOIN snapshot_concepts snap ON snap.concept_id = c.id AND snap.snapshot_id = ?
    WHERE s.workspace_id = ? AND s.fingerprint = ? AND c.workspace_id = s.workspace_id AND c.portable = 0`);
  const collect = db.prepare('INSERT OR IGNORE INTO migration_baseline_keys VALUES (?, ?, ?)');
  for (const { workspace_id, snapshot_id, proposal } of generations.iterate()) {
    assert.ok(typeof workspace_id === 'string' && typeof snapshot_id === 'number');
    assert.ok(typeof proposal === 'string');
    const parsed = savedProposal.safeParse(JSON.parse(proposal));
    if (!parsed.success) continue;
    for (const input of parsed.data.concepts) {
      const saved = scoped.get(snapshot_id, workspace_id, releasedScopedFingerprint(input));
      if (!saved) continue;
      assert.ok(typeof saved.id === 'number' && typeof saved.title === 'string' && typeof saved.summary === 'string');
      if (!compatibleScopedMeanings(input, { key: input.key, title: saved.title, summary: saved.summary })) continue;
      collect.run(workspace_id, saved.id, baselineConceptFingerprint(input));
    }
  }
  // A released fingerprint could represent several unrelated provider keys with the same title.
  db.exec(`WITH attributable AS (
      SELECT workspace_id, concept_id, min(fingerprint) AS fingerprint FROM migration_baseline_keys
      GROUP BY workspace_id, concept_id HAVING count(*) = 1
    ), unique_binding AS (
      SELECT workspace_id, min(concept_id) AS concept_id, fingerprint FROM attributable
      GROUP BY workspace_id, fingerprint HAVING count(*) = 1
    )
    UPDATE scoped_proposal_concepts AS scoped SET fingerprint = binding.fingerprint
    FROM unique_binding binding WHERE scoped.workspace_id = binding.workspace_id AND scoped.concept_id = binding.concept_id;
    DROP TABLE migration_baseline_keys;`);
}

export function indexSavedConceptKeys(db: Db): void {
  indexSavedBaselines(db);
  indexSavedChanges(db);
}
