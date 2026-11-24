import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getConcept, type Concept } from './concepts';
import type { Db } from './connection';
import { compatibleDescriptions, compatiblePortableAliases, normalizedConceptName, portableAlias } from './portable-identity';

export type ChangeConceptScope = { workspaceId: string; change: string };
type Footprint = { key: string; title: string; summary: string };

export function changeIdentity(kind: 'pr' | 'commit', ref: string, base: string | null | undefined, head: string): string {
  assert.ok(ref && head, 'a change identity needs a ref and head');
  assert.ok(kind === 'pr' || ref.toLowerCase() === head.toLowerCase(), 'the commit ref must be resolved');
  return createHash('sha256').update(JSON.stringify([kind, ref.toLowerCase(), base?.toLowerCase() ?? null, head.toLowerCase()])).digest('hex');
}

export const changeTitleKey = (title: string) => 'title:' + normalizedConceptName(title);
export const changeProviderKey = (key: string) => 'key:' + key.trim().toLowerCase();
export const overviewKey = 'overview';

function changeConceptsForKey(db: Db, scope: ChangeConceptScope, key: string, alias?: string): Concept[] {
  assert.match(scope.change, /^[a-f0-9]{64}$/);
  assert.ok(scope.workspaceId && key);
  return db.prepare(`SELECT k.concept_id FROM change_concept_keys k
    WHERE k.workspace_id = ? AND k.change_id = ? AND k.identity = ?
    AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM change_concept_keys conflict
      WHERE conflict.workspace_id = k.workspace_id AND conflict.change_id = k.change_id AND conflict.concept_id = k.concept_id
        AND conflict.identity GLOB 'alias:*' AND conflict.identity <> ?))`)
    .all(scope.workspaceId, scope.change, key, alias ?? null, alias ?? null).map(row => {
    assert.ok(typeof row.concept_id === 'number');
    const concept = getConcept(db, row.concept_id);
    assert.ok(concept && (concept.portable || concept.workspaceId === scope.workspaceId));
    return concept;
  });
}

export function findChangeOverview(db: Db, scope: ChangeConceptScope): Concept | null {
  const [overview, extra] = changeConceptsForKey(db, scope, overviewKey);
  assert.ok(!extra, 'a change has one overview');
  assert.ok(!overview || (!overview.portable && overview.workspaceId === scope.workspaceId));
  return overview ?? null;
}

export function isGeneratedChangeConcept(workspaceId: string, concept: Concept): boolean {
  return !concept.portable && concept.key.startsWith(`ws/${workspaceId}/change/`);
}

export function findCompatibleChangeTitle(db: Db, scope: ChangeConceptScope, input: Footprint): Concept | null {
  const alias = portableAlias(input.key, input.title);
  if (alias === null) return null;
  const matches = changeConceptsForKey(db, scope, changeTitleKey(input.title), alias && 'alias:' + alias)
    .filter(concept => isGeneratedChangeConcept(scope.workspaceId, concept)
      && compatibleChangeAliases(scope, input, concept) && compatibleDescriptions(input.summary, concept.summary));
  return matches.length === 1 ? matches[0]! : null;
}

function compatibleChangeAliases(scope: ChangeConceptScope, input: Pick<Footprint, 'key' | 'title'>, concept: Concept): boolean {
  assert.ok(input.title.trim() && concept.title.trim());
  assert.ok(concept.portable || concept.workspaceId === scope.workspaceId);
  const storedKey = concept.portable ? concept.key : concept.key.slice(`ws/${scope.workspaceId}/`.length);
  return compatiblePortableAliases(portableAlias(input.key, input.title), portableAlias(storedKey, concept.title));
}

export function findScopedChangeKey(db: Db, scope: ChangeConceptScope, input: Footprint): Concept | null {
  assert.ok(input.key.trim());
  assert.ok(input.title.trim());
  const alias = portableAlias(input.key, input.title);
  if (alias === null) return null;
  const scopedAlias = alias && 'alias:' + alias;
  const keyed = changeConceptsForKey(db, scope, changeProviderKey(input.key), scopedAlias)
    .filter(concept => compatibleChangeAliases(scope, input, concept));
  const exact = keyed.filter(concept => compatibleDescriptions(input.summary, concept.summary));
  if (exact.length) return exact.length === 1 ? exact[0]! : null;
  if (scopedAlias) {
    const matches = changeConceptsForKey(db, scope, scopedAlias, scopedAlias)
      .filter(concept => compatibleChangeAliases(scope, input, concept) && compatibleDescriptions(input.summary, concept.summary));
    if (matches.length) return matches.length === 1 ? matches[0]! : null;
  }
  const [local] = keyed;
  // A saved local key identifies the same scoped footprint across levels of detail.
  if (keyed.length === 1 && local && isGeneratedChangeConcept(scope.workspaceId, local)) return local;
  return null;
}

export function rememberChangeFootprint(db: Db, scope: ChangeConceptScope, input: Footprint, concept: Concept): void {
  assert.ok(input.key.trim());
  assert.ok(input.title.trim());
  const keys = [changeProviderKey(input.key), changeTitleKey(input.title)];
  const alias = portableAlias(input.key, input.title);
  if (alias) keys.push('alias:' + alias);
  rememberChangeConcept(db, scope, concept, ...keys);
}

export function changeVocabulary(db: Db, scope: ChangeConceptScope) {
  assert.match(scope.change, /^[a-f0-9]{64}$/);
  return db.prepare(`SELECT min(substr(k.identity, 5)) AS key, c.title, substr(c.summary, 1, 320) AS summary
    FROM change_concept_keys k JOIN concepts c ON c.id = k.concept_id
    WHERE k.workspace_id = ? AND k.change_id = ? AND k.identity GLOB 'key:*'
      AND NOT EXISTS (SELECT 1 FROM change_concept_keys other WHERE other.workspace_id = k.workspace_id
        AND other.change_id = k.change_id AND other.identity = k.identity AND other.concept_id <> k.concept_id)
    GROUP BY c.id ORDER BY c.id LIMIT 60`).all(scope.workspaceId, scope.change).map(({ key, title, summary }) => {
    assert.ok(typeof key === 'string' && key.length > 0);
    assert.ok(typeof title === 'string' && typeof summary === 'string');
    return { key, title, summary };
  });
}

export function rememberChangeConcept(db: Db, scope: ChangeConceptScope, concept: Concept, ...keys: string[]): void {
  assert.ok(db.isTransaction);
  assert.ok(concept.portable || concept.workspaceId === scope.workspaceId);
  const insert = db.prepare(`INSERT INTO change_concept_keys (workspace_id, change_id, identity, concept_id) VALUES (?, ?, ?, ?)
    ON CONFLICT DO NOTHING`);
  for (const key of keys) insert.run(scope.workspaceId, scope.change, key, concept.id);
}

function keepStrongestEvidence(db: Db, legacyId: number, canonicalId: number): void {
  assert.ok(db.isTransaction);
  assert.notEqual(legacyId, canonicalId);
  db.prepare(`INSERT INTO evidence (concept_id, depth, status, source, note, workspace_id, snapshot_id, revision, recorded_at,
    mastery_verified, probe_answered)
    SELECT :canonical, depth, status, source, note, workspace_id, snapshot_id, revision, recorded_at, mastery_verified, probe_answered
    FROM evidence WHERE concept_id = :legacy
    ON CONFLICT (concept_id, depth) DO UPDATE SET
      (status, source, note, workspace_id, snapshot_id, revision, recorded_at, mastery_verified) =
        (excluded.status, excluded.source, excluded.note, excluded.workspace_id, excluded.snapshot_id, excluded.revision,
          excluded.recorded_at, excluded.mastery_verified),
      probe_answered = max(evidence.probe_answered, excluded.probe_answered)
    WHERE (excluded.mastery_verified, CASE excluded.status WHEN 'demonstrated' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END,
      excluded.revision, excluded.recorded_at) >
      (evidence.mastery_verified, CASE evidence.status WHEN 'demonstrated' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END,
      evidence.revision, evidence.recorded_at)`).run({ canonical: canonicalId, legacy: legacyId });
  db.prepare(`UPDATE evidence SET probe_answered = 1 WHERE concept_id = ? AND depth IN (
    SELECT depth FROM evidence WHERE concept_id = ? AND probe_answered = 1)`).run(canonicalId, legacyId);
}

export function linkChangeDuplicate(db: Db, legacy: Concept, canonical: Concept): void {
  if (legacy.id === canonical.id) return;
  assert.ok(db.isTransaction);
  assert.ok(!legacy.portable && !canonical.portable && legacy.workspaceId === canonical.workspaceId);
  const link = db.prepare('INSERT INTO concept_identity_links (legacy_concept_id, canonical_concept_id) VALUES (?, ?)');
  assert.equal(link.run(legacy.id, canonical.id).changes, 1);
  db.prepare('UPDATE concept_identity_links SET canonical_concept_id = ? WHERE canonical_concept_id = ?').run(canonical.id, legacy.id);
  db.prepare(`INSERT INTO change_concept_keys (workspace_id, change_id, identity, concept_id)
    SELECT workspace_id, change_id, identity, ? FROM change_concept_keys WHERE concept_id = ? ON CONFLICT DO NOTHING`)
    .run(canonical.id, legacy.id);
  db.prepare('DELETE FROM change_concept_keys WHERE concept_id = ?').run(legacy.id);
  db.prepare(`INSERT INTO workspace_concepts (workspace_id, concept_id, on_atlas)
    SELECT workspace_id, ?, on_atlas FROM workspace_concepts WHERE concept_id = ?
    ON CONFLICT (workspace_id, concept_id) DO UPDATE SET on_atlas = max(on_atlas, excluded.on_atlas)`).run(canonical.id, legacy.id);
  db.prepare('UPDATE workspace_concepts SET on_atlas = 0 WHERE concept_id = ?').run(legacy.id);
  keepStrongestEvidence(db, legacy.id, canonical.id);
}
