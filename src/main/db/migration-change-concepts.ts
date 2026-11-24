import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { plainConceptTitle } from '../../shared/plain-language';
import { changeIdentity, changeTitleKey, findChangeOverview, findCompatibleChangeTitle, findScopedChangeKey,
  isGeneratedChangeConcept, linkChangeDuplicate, overviewKey, rememberChangeConcept, rememberChangeFootprint } from './change-concept-identity';
import { canonicalConceptId, getConcept, type Concept } from './concepts';
import type { Db } from './connection';
import { compatibleDescriptions, compatiblePortableAliases, portableAlias, scopedFingerprint } from './portable-identity';

type Footprint = { key: string; title: string; summary: string; portable: boolean; concept: Concept; generated: boolean };

interface SavedChange {
  workspaceId: string;
  change: string;
  overview: Concept;
  title: string;
  footprints: Footprint[];
}

function readSavedFootprints(db: Db) {
  assert.ok(db.isTransaction);
  // Match only the generated local keys written by the v10 generation path.
  db.function('delve_v10_change_key', { directOnly: true, deterministic: true }, (workspace, snapshot, key, title, summary, portable) => {
    if (typeof key !== 'string' || typeof title !== 'string' || typeof summary !== 'string') return null;
    assert.ok(typeof workspace === 'string' && typeof snapshot === 'number');
    const fingerprint = scopedFingerprint({ key, title, summary, portable: portable === 1 });
    const hash = createHash('sha256').update(JSON.stringify(['concept', snapshot, fingerprint])).digest('hex');
    return `ws/${workspace}/change/${hash}`;
  });
  const inputs = db.prepare(`SELECT p.value ->> '$.key' AS key, p.value ->> '$.title' AS title,
    p.value ->> '$.summary' AS summary, p.value ->> '$.portable' AS portable, sc.concept_id AS generatedId
    FROM repository_generations g
    JOIN json_each(g.proposal, '$.concepts') p
    LEFT JOIN concepts c ON c.key = delve_v10_change_key(g.workspace_id, g.snapshot_id, p.value ->> '$.key',
      p.value ->> '$.title', p.value ->> '$.summary', p.value ->> '$.portable')
    LEFT JOIN snapshot_concepts sc ON sc.snapshot_id = g.snapshot_id AND sc.concept_id = c.id
    WHERE g.id = ? ORDER BY p.key`);
  const recorded = db.prepare(`SELECT t.value ->> '$.id' AS id FROM repository_generations g
    JOIN json_each(g.result, '$.brief.touched') t WHERE g.id = :id
    UNION SELECT next_concept FROM repository_generations WHERE id = :id`);
  return (id: number, workspaceId: string, overviewId: number): Footprint[] => {
    const recordedIds = new Set(recorded.all({ id }).map(row => row.id));
    const concepts = [...recordedIds].flatMap(recordedId => {
      if (typeof recordedId !== 'number' || recordedId === overviewId) return [];
      const concept = getConcept(db, canonicalConceptId(db, recordedId));
      return concept && !isGeneratedChangeConcept(workspaceId, concept) ? [concept] : [];
    });
    return inputs.all(id).flatMap(({ key, title, summary, portable, generatedId }) => {
      if (typeof key !== 'string' || typeof title !== 'string' || typeof summary !== 'string') return [];
      assert.ok(portable === 0 || portable === 1);
      const input = { key, title, summary, portable: portable === 1 };
      const wasSelected = typeof generatedId === 'number' && recordedIds.has(generatedId);
      const mapped = wasSelected ? null : corroboratedSavedConcept(concepts, workspaceId, input);
      const generated = !mapped && typeof generatedId === 'number';
      const concept = generated ? getConcept(db, generatedId) : mapped;
      if (!concept) return [];
      assert.ok(concept.portable || concept.workspaceId === workspaceId);
      return [{ ...input, concept, generated }];
    });
  };
}

function corroboratedSavedConcept(concepts: Concept[], workspaceId: string, input: Omit<Footprint, 'concept' | 'generated'>): Concept | null {
  const prefix = `ws/${workspaceId}/`;
  const alias = portableAlias(input.key, input.title);
  const matches = concepts.filter(concept => {
    if (!concept.portable && !concept.key.startsWith(prefix)) return false;
    const key = concept.portable ? concept.key : concept.key.slice(prefix.length);
    const candidateAlias = portableAlias(key, concept.title);
    return (key === input.key || (alias !== undefined && alias === candidateAlias))
      && compatiblePortableAliases(alias, candidateAlias) && compatibleDescriptions(input.summary, concept.summary);
  });
  return matches.length === 1 ? matches[0]! : null;
}

function readSavedChanges(db: Db): SavedChange[] {
  assert.ok(db.isTransaction);
  const footprints = readSavedFootprints(db);
  const rows = db.prepare(`SELECT g.id, g.workspace_id AS workspaceId, g.kind, g.ref, g.depth, s.commit_sha AS head,
    g.result ->> '$.brief.base' AS base, c.id AS overviewId, g.proposal ->> '$.conceptTitle' AS plainTitle,
    g.result ->> '$.brief.title' AS sourceTitle
    FROM repository_generations g JOIN snapshots s ON s.id = g.snapshot_id
    JOIN concepts c ON c.id = g.result ->> '$.brief.conceptId' AND c.workspace_id = g.workspace_id
    WHERE g.kind <> 'baseline' ORDER BY (g.depth = 'high') DESC, g.id`).iterate();
  return Array.from(rows, row => {
    const { id, workspaceId, kind, ref, depth, head, base, overviewId, plainTitle, sourceTitle } = row;
    assert.ok(typeof id === 'number' && typeof workspaceId === 'string' && typeof head === 'string');
    assert.ok(typeof ref === 'string' && (kind === 'pr' || kind === 'commit') && (base === null || typeof base === 'string'));
    assert.ok(typeof overviewId === 'number');
    const overview = getConcept(db, overviewId);
    assert.ok(overview && !overview.portable);
    const title = typeof plainTitle === 'string' ? plainTitle
      : typeof sourceTitle === 'string' ? plainConceptTitle(sourceTitle) : overview.title;
    return { workspaceId, change: changeIdentity(kind, kind === 'commit' ? head : ref, base, head), overview,
      title: depth === 'high' ? title : (typeof sourceTitle === 'string' ? sourceTitle : overview.title),
      footprints: footprints(id, workspaceId, overviewId) };
  });
}

export function reconcileSavedChanges(db: Db): void {
  assert.ok(db.isTransaction);
  const changes = readSavedChanges(db);
  const owner = new Map<number, string | null>();
  for (const scope of changes) {
    for (const { concept, generated } of scope.footprints) {
      if (!generated) continue;
      const prior = owner.get(concept.id);
      owner.set(concept.id, prior === undefined || prior === scope.change ? scope.change : null);
    }
  }

  const aliases = new Set<number>();
  for (const scope of changes) {
    const canonical = findChangeOverview(db, scope) ?? scope.overview;
    if (scope.overview.id !== canonical.id && !aliases.has(scope.overview.id)) {
      linkChangeDuplicate(db, scope.overview, canonical);
      aliases.add(scope.overview.id);
    }
    rememberChangeConcept(db, scope, canonical, overviewKey);
    rememberChangeConcept(db, scope, canonical, changeTitleKey(scope.title), changeTitleKey(scope.overview.title));
  }
  for (const scope of changes) {
    for (const input of scope.footprints) {
      const { concept, generated } = input;
      if (generated && owner.get(concept.id) !== scope.change) continue;
      if (aliases.has(concept.id)) {
        const canonical = getConcept(db, canonicalConceptId(db, concept.id));
        assert.ok(canonical && !aliases.has(canonical.id));
        rememberChangeFootprint(db, scope, input, canonical);
        continue;
      }
      const prior = generated ? findScopedChangeKey(db, scope, input) ?? findCompatibleChangeTitle(db, scope, input) : null;
      const canonical = prior && isGeneratedChangeConcept(scope.workspaceId, prior) ? prior : concept;
      assert.ok(!aliases.has(canonical.id), 'resolved change identities must be canonical');
      if (canonical.id !== concept.id) {
        linkChangeDuplicate(db, concept, canonical);
        aliases.add(concept.id);
      }
      rememberChangeFootprint(db, scope, input, canonical);
    }
  }
}
