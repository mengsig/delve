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
type RecoveredFootprint = { concept: Concept; titleHash: boolean };

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

function savedFootprint(db: Db, workspaceId: string, snapshotId: number, explicitId: number | undefined,
  input: Footprint, hashOwners: Map<number, string | null>): RecoveredFootprint | null {
  assert.ok(db.isTransaction && snapshotId > 0);
  assert.ok(input.key && workspaceId);
  const prefix = `ws/${workspaceId}/`;
  const hash = createHash('sha256').update(JSON.stringify(['concept', snapshotId, releasedScopedFingerprint(input)])).digest('hex');
  const generated = getConceptByKey(db, prefix + 'change/' + hash);
  const candidates = [getConceptByKey(db, prefix + input.key), input.portable ? findPortableConcept(db, input) : null, generated];
  const membership = db.prepare('SELECT 1 FROM snapshot_concepts WHERE snapshot_id = ? AND concept_id = ?');
  const matches = new Map<number, RecoveredFootprint>();
  let attributed: RecoveredFootprint | undefined;
  for (const saved of candidates) {
    if (!saved || !compatibleScopedMeanings(input, { ...saved, key: saved.portable ? saved.key : input.key })) continue;
    const canonical = getConcept(db, canonicalConceptId(db, saved.id));
    assert.ok(canonical && (canonical.portable || canonical.workspaceId === workspaceId));
    if (!compatibleScopedMeanings(input, { ...canonical, key: canonical.portable ? canonical.key : input.key })) continue;
    const explicit = saved.id === explicitId || canonical.id === explicitId;
    if (!explicit && !membership.get(snapshotId, saved.id)) continue;
    const titleHash = saved.id === generated?.id && input.portable && typeof portableAlias(input.key, input.title) === 'string';
    const binding = { concept: canonical, titleHash };
    if (titleHash) {
      const key = portableAlias(input.key, '') ?? input.key;
      const owner = hashOwners.get(canonical.id);
      hashOwners.set(canonical.id, owner === undefined || owner === key ? key : null);
    }
    if (explicit) attributed = binding;
    matches.set(canonical.id, binding);
  }
  return attributed ?? (matches.size === 1 ? matches.values().next().value! : null);
}

function indexSavedChanges(db: Db): void {
  assert.ok(db.isTransaction);
  const rows = db.prepare(`SELECT g.workspace_id, g.kind, g.ref, g.snapshot_id, s.commit_sha, g.result, g.proposal, g.next_concept
    FROM repository_generations g JOIN snapshots s ON s.id = g.snapshot_id
    WHERE g.kind IN ('pr', 'commit') AND g.schema_version = 'delve.change/1' ORDER BY g.id`).iterate();
  const overviews = new Map<string, { workspaceId: string; change: string; ids: Set<number> }>();
  const hashOwners = new Map<number, string | null>();
  const hashed: { scope: ChangeConceptScope; concept: Concept; input: Footprint }[] = [];
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
    for (const input of parsed.data.concepts) {
      const recovered = savedFootprint(db, workspaceId, snapshotId, ids.get(input.key), input, hashOwners);
      if (!recovered || recovered.concept.id === brief.conceptId) continue;
      if (recovered.titleHash) hashed.push({ scope, concept: recovered.concept, input });
      else rememberChangeConcept(db, scope, recovered.concept, input);
    }
  }
  // Schema 9 could route distinct keys to one generated hash through a familiar title.
  for (const { scope, concept, input } of hashed) {
    if (hashOwners.get(concept.id) === (portableAlias(input.key, '') ?? input.key)) rememberChangeConcept(db, scope, concept, input);
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
