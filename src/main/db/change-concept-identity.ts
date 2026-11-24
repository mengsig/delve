import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getConcept, type Concept } from './concepts';
import type { Db } from './connection';
import { compatibleScopedMeanings, type ConceptMeaning } from './portable-identity';

export type ChangeConceptScope = { workspaceId: string; change: string };

export function changeIdentity(kind: 'pr' | 'commit', ref: string, base: string | null | undefined, head: string): string {
  assert.ok(ref && head, 'a change identity needs a ref and head');
  assert.ok(kind === 'pr' || ref.toLowerCase() === head.toLowerCase(), 'the commit ref must be resolved');
  return createHash('sha256').update(JSON.stringify([kind, ref.toLowerCase(), base?.toLowerCase() ?? null, head.toLowerCase()])).digest('hex');
}

export const overviewKey = 'overview';
const providerKey = (key: string) => 'key:' + key;

export function findChangeOverview(db: Db, scope: ChangeConceptScope): Concept | null {
  const rows = db.prepare('SELECT concept_id FROM change_concept_keys WHERE workspace_id = ? AND change_id = ? AND identity = ?')
    .all(scope.workspaceId, scope.change, overviewKey);
  if (rows.length !== 1) return null;
  const id = rows[0]!.concept_id;
  assert.ok(typeof id === 'number');
  const overview = getConcept(db, id);
  assert.ok(overview && !overview.portable && overview.workspaceId === scope.workspaceId);
  return overview;
}

export function findScopedChangeKey(db: Db, scope: ChangeConceptScope, input: ConceptMeaning & { portable: boolean }): Concept | null {
  const { key, portable } = input;
  assert.match(scope.change, /^[a-f0-9]{64}$/);
  assert.ok(scope.workspaceId && key);
  const rows = db.prepare(`SELECT k.concept_id, k.title, k.summary, overview.concept_id AS overview
    FROM change_concept_keys k LEFT JOIN change_concept_keys overview ON overview.workspace_id = k.workspace_id
      AND overview.change_id = k.change_id AND overview.identity = 'overview' AND overview.concept_id = k.concept_id
    WHERE k.workspace_id = ? AND k.change_id = ? AND k.identity = ?`).iterate(scope.workspaceId, scope.change, providerKey(key));
  const compatible: Concept[] = [];
  for (const { concept_id, title, summary, overview } of rows) {
    assert.ok(typeof concept_id === 'number' && typeof summary === 'string' && typeof title === 'string');
    if (!compatibleScopedMeanings(input, { key, title, summary })) continue;
    const concept = getConcept(db, concept_id);
    assert.ok(concept && (concept.portable || concept.workspaceId === scope.workspaceId));
    const meaning = { key: concept.portable ? concept.key : key, title: concept.title, summary: overview ? summary : concept.summary };
    if (compatibleScopedMeanings(input, meaning)) compatible.push(concept);
  }
  // Released profiles can already have an independently saved local and portable concept.
  const matches = compatible.length > 1 ? compatible.filter(concept => concept.portable === portable) : compatible;
  return matches.length === 1 ? matches[0]! : null;
}

export function rememberChangeConcept(db: Db, scope: ChangeConceptScope, concept: Concept, footprint?: ConceptMeaning): void {
  assert.ok(db.isTransaction);
  assert.ok(concept.portable || concept.workspaceId === scope.workspaceId);
  db.prepare(`INSERT INTO change_concept_keys (workspace_id, change_id, identity, concept_id, title, summary) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING`).run(scope.workspaceId, scope.change, footprint ? providerKey(footprint.key) : overviewKey, concept.id,
    footprint?.title ?? '', footprint?.summary ?? '');
}

export function changeVocabulary(db: Db, scope: ChangeConceptScope) {
  assert.match(scope.change, /^[a-f0-9]{64}$/);
  assert.ok(scope.workspaceId);
  return db.prepare(`SELECT substr(k.identity, 5) AS key, substr(c.title, 1, 180) AS title, k.summary,
    EXISTS (SELECT 1 FROM change_concept_keys overview WHERE overview.workspace_id = k.workspace_id
      AND overview.change_id = k.change_id AND overview.identity = 'overview' AND overview.concept_id = k.concept_id) AS overview
    FROM change_concept_keys k JOIN concepts c ON c.id = k.concept_id
    WHERE k.workspace_id = ? AND k.change_id = ? AND k.identity GLOB 'key:*' AND length(k.summary) <= 600
      AND NOT EXISTS (SELECT 1 FROM change_concept_keys other WHERE other.workspace_id = k.workspace_id
        AND other.change_id = k.change_id AND other.identity = k.identity AND other.concept_id <> k.concept_id)
    ORDER BY overview DESC, c.id LIMIT 60`).all(scope.workspaceId, scope.change).map(({ key, title, summary, overview }) => {
    assert.ok(typeof key === 'string' && /^[a-z0-9][a-z0-9._/-]{0,149}$/.test(key));
    assert.ok(typeof title === 'string' && typeof summary === 'string');
    assert.ok(overview === 0 || overview === 1);
    return { key, title, summary, overview: overview === 1 };
  });
}
