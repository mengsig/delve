import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getConcept, type Concept } from './concepts';
import type { Db } from './connection';
import { normalizedConceptName } from './portable-identity';

export type ChangeConceptScope = { workspaceId: string; change: string };

export function changeIdentity(kind: 'pr' | 'commit', ref: string, base: string | null | undefined, head: string): string {
  assert.ok(ref && head, 'a change identity needs a ref and head');
  assert.ok(kind === 'pr' || ref.toLowerCase() === head.toLowerCase(), 'the commit ref must be resolved');
  return createHash('sha256').update(JSON.stringify([kind, ref.toLowerCase(), base?.toLowerCase() ?? null, head.toLowerCase()])).digest('hex');
}

export const changeTitleKey = (title: string) => 'title:' + normalizedConceptName(title);
export const changeProviderKey = (key: string) => 'key:' + key.trim().toLowerCase();
export const overviewKey = 'overview';

export function findChangeConcept(db: Db, scope: ChangeConceptScope, ...keys: string[]): Concept | null {
  assert.ok(keys.length > 0);
  const lookup = db.prepare('SELECT concept_id FROM change_concept_keys WHERE workspace_id = ? AND change_id = ? AND identity = ?');
  for (const key of keys) {
    const row = lookup.get(scope.workspaceId, scope.change, key);
    if (!row) continue;
    assert.ok(typeof row.concept_id === 'number');
    const concept = getConcept(db, row.concept_id);
    assert.ok(concept && !concept.portable && concept.workspaceId === scope.workspaceId);
    return concept;
  }
  return null;
}

export function changeVocabulary(db: Db, scope: ChangeConceptScope) {
  assert.match(scope.change, /^[a-f0-9]{64}$/);
  return db.prepare(`SELECT min(substr(k.identity, 5)) AS key, c.title, substr(c.summary, 1, 320) AS summary
    FROM change_concept_keys k JOIN concepts c ON c.id = k.concept_id
    WHERE k.workspace_id = ? AND k.change_id = ? AND k.identity GLOB 'key:*'
    GROUP BY c.id ORDER BY c.id LIMIT 60`).all(scope.workspaceId, scope.change).map(({ key, title, summary }) => {
    assert.ok(typeof key === 'string' && key.length > 0);
    assert.ok(typeof title === 'string' && typeof summary === 'string');
    return { key, title, summary };
  });
}

export function rememberChangeConcept(db: Db, scope: ChangeConceptScope, concept: Concept, ...keys: string[]): void {
  assert.ok(db.isTransaction);
  assert.ok(!concept.portable && concept.workspaceId === scope.workspaceId);
  const insert = db.prepare(`INSERT INTO change_concept_keys (workspace_id, change_id, identity, concept_id) VALUES (?, ?, ?, ?)
    ON CONFLICT (workspace_id, change_id, identity) DO NOTHING`);
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
  db.prepare('UPDATE change_concept_keys SET concept_id = ? WHERE concept_id = ?').run(canonical.id, legacy.id);
  db.prepare(`INSERT INTO workspace_concepts (workspace_id, concept_id, on_atlas)
    SELECT workspace_id, ?, on_atlas FROM workspace_concepts WHERE concept_id = ?
    ON CONFLICT (workspace_id, concept_id) DO UPDATE SET on_atlas = max(on_atlas, excluded.on_atlas)`).run(canonical.id, legacy.id);
  db.prepare('UPDATE workspace_concepts SET on_atlas = 0 WHERE concept_id = ?').run(legacy.id);
  keepStrongestEvidence(db, legacy.id, canonical.id);
}
