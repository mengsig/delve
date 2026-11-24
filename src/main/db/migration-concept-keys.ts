import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { changeIdentity, rememberChangeConcept, type ChangeConceptScope } from './change-concept-identity';
import { canonicalConceptId, getConcept, getConceptByKey, type Concept } from './concepts';
import type { Db } from './connection';
import { findPortableConcept } from './portable-concepts';
import { baselineConceptFingerprint, compatibleScopedMeanings, portableAlias, releasedScopedFingerprint } from './portable-identity';

const savedKey = z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,149}$/);
const savedProposal = z.object({ concepts: z.array(z.object({
  key: savedKey, title: z.string().trim().min(1), summary: z.string().trim().min(1), portable: z.boolean(),
})).max(60) });
const savedChangeProposal = savedProposal.extend({
  touched: z.array(savedKey).max(60), recommendation: z.object({ key: savedKey.nullable() }).optional(),
});
const savedBrief = z.object({ brief: z.object({
  conceptId: z.int().positive(), base: z.string().nullish(), touched: z.array(z.object({ id: z.int().positive() })),
}) });
type Footprint = z.infer<typeof savedProposal>['concepts'][number];
type ArchivedBrief = z.infer<typeof savedBrief>['brief'];
type ArchivedProposal = z.infer<typeof savedChangeProposal>;
type Claim = { concept: Concept; input: Footprint };
type Binding = Claim & { scope: ChangeConceptScope };
type Recovered = { bound: Concept | null; claims: Concept[] };

function attributedFootprints(proposal: ArchivedProposal, brief: ArchivedBrief, next: number): Map<string, number> {
  assert.ok(brief.conceptId > 0);
  assert.ok(next > 0);
  const ids = new Map<string, number>();
  // Schema 9 wrote touched IDs in proposal order but collapsed repeated IDs.
  if (proposal.touched.length === brief.touched.length) {
    proposal.touched.forEach((key, index) => ids.set(key, brief.touched[index]!.id));
  }
  const key = proposal.recommendation?.key;
  if (key && next !== brief.conceptId) {
    const touched = ids.get(key);
    if (touched === undefined || touched === next) ids.set(key, next);
    else ids.delete(key);
  }
  return ids;
}

// Schema 9 derived a portable footprint's generated key from a familiar title when its own key had no alias.
function keyDerivedHash(input: Footprint): boolean {
  return !input.portable || portableAlias(input.key, '') !== undefined || portableAlias(input.key, input.title) === undefined;
}

const ownerKey = (input: Footprint) => portableAlias(input.key, '') ?? input.key;

function compatibleSaved(db: Db, workspaceId: string, input: Footprint, saved: Concept): Concept | null {
  assert.ok(input.key && workspaceId);
  if (!saved.portable && saved.workspaceId !== workspaceId) return null;
  if (!compatibleScopedMeanings(input, { ...saved, key: saved.portable ? saved.key : input.key })) return null;
  const canonical = getConcept(db, canonicalConceptId(db, saved.id));
  assert.ok(canonical && (canonical.portable || canonical.workspaceId === workspaceId));
  return compatibleScopedMeanings(input, { ...canonical, key: canonical.portable ? canonical.key : input.key }) ? canonical : null;
}

function savedFootprint(db: Db, workspaceId: string, snapshotId: number, reference: number | undefined, input: Footprint,
  collapsed: readonly number[]): Recovered {
  assert.ok(db.isTransaction && snapshotId > 0);
  assert.ok(input.key && workspaceId);
  const compatible = (saved: Concept | null) => saved && compatibleSaved(db, workspaceId, input, saved);
  // A saved reference is authoritative: an incompatible one keeps the footprint unbound instead of guessing.
  if (reference !== undefined) {
    const concept = compatible(getConcept(db, reference));
    return { bound: concept, claims: concept ? [concept] : [] };
  }
  const prefix = `ws/${workspaceId}/`;
  const hash = createHash('sha256').update(JSON.stringify(['concept', snapshotId, releasedScopedFingerprint(input)])).digest('hex');
  const generated = getConceptByKey(db, prefix + 'change/' + hash);
  const membership = db.prepare('SELECT 1 FROM snapshot_concepts WHERE snapshot_id = ? AND concept_id = ?');
  const member = (saved: Concept | null) => saved && membership.get(snapshotId, saved.id) ? compatible(saved) : null;
  const stable = [getConceptByKey(db, prefix + input.key), input.portable ? findPortableConcept(db, input) : null,
    keyDerivedHash(input) ? generated : null];
  const matches = new Map(stable.map(member).filter(concept => concept !== null).map(concept => [concept.id, concept]));
  // Title-derived and collapsed touched concepts may be this footprint's, so they withhold an index but never bind.
  const possible = [member(generated), ...collapsed.map(id => compatible(getConcept(db, id)))];
  const claims = new Map([...matches, ...possible.filter(concept => concept !== null).map(concept => [concept.id, concept] as const)]);
  return { bound: matches.size === 1 ? matches.values().next().value! : null, claims: [...claims.values()] };
}

function soleOwners(bindings: readonly Binding[], claims: readonly Claim[]): Binding[] {
  const owners = new Map<number, Set<string>>();
  for (const { concept, input } of claims) owners.set(concept.id, (owners.get(concept.id) ?? new Set()).add(ownerKey(input)));
  return bindings.filter(({ concept, input }) => {
    const keys = owners.get(concept.id);
    assert.ok(keys && keys.has(ownerKey(input)), 'every bound concept is claimed by its footprint');
    return keys.size === 1;
  });
}

function indexSavedChanges(db: Db): void {
  assert.ok(db.isTransaction);
  const rows = db.prepare(`SELECT g.workspace_id, g.kind, g.ref, g.snapshot_id, s.commit_sha, g.result, g.proposal, g.next_concept
    FROM repository_generations g JOIN snapshots s ON s.id = g.snapshot_id
    WHERE g.kind IN ('pr', 'commit') AND g.schema_version = 'delve.change/1' ORDER BY g.id`).iterate();
  const overviews = new Map<string, { workspaceId: string; change: string; ids: Set<number> }>();
  const bindings: Binding[] = [];
  const claims: Claim[] = [];
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
    const parsed = savedChangeProposal.safeParse(JSON.parse(proposal));
    if (!parsed.success) continue;
    const ids = attributedFootprints(parsed.data, brief, next_concept);
    const touched = new Set(parsed.data.touched);
    const collapsed = touched.size === brief.touched.length ? [] : brief.touched.map(concept => concept.id);
    for (const input of parsed.data.concepts) {
      const recovered = savedFootprint(db, workspaceId, snapshotId, ids.get(input.key), input, touched.has(input.key) ? collapsed : []);
      claims.push(...recovered.claims.map(concept => ({ concept, input })));
      if (recovered.bound && recovered.bound.id !== brief.conceptId) bindings.push({ scope, concept: recovered.bound, input });
    }
  }
  // Schema 9 could route distinct keys to one concept, so a concept claimed under several keys stays unindexed.
  for (const { scope, concept, input } of soleOwners(bindings, claims)) rememberChangeConcept(db, scope, concept, input);
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
