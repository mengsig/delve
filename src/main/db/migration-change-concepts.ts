import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { plainConceptTitle } from '../../shared/plain-language';
import { changeIdentity, changeProviderKey, changeTitleKey, findChangeConcept, linkChangeDuplicate, overviewKey, rememberChangeConcept } from './change-concept-identity';
import { getConcept, type Concept } from './concepts';
import type { Db } from './connection';
import { scopedFingerprint } from './portable-identity';

interface SavedChange {
  workspaceId: string;
  change: string;
  overview: Concept;
  title: string;
  footprints: { concept: Concept; key: string }[];
}

function readSavedChanges(db: Db): SavedChange[] {
  assert.ok(db.isTransaction);
  // Match only the generated local keys written by the v10 generation path.
  db.function('delve_v10_change_key', { directOnly: true, deterministic: true }, (workspace, snapshot, key, title, summary, portable) => {
    if (typeof key !== 'string' || typeof title !== 'string' || typeof summary !== 'string') return null;
    assert.ok(typeof workspace === 'string' && typeof snapshot === 'number');
    const fingerprint = scopedFingerprint({ key, title, summary, portable: portable === 1 });
    const hash = createHash('sha256').update(JSON.stringify(['concept', snapshot, fingerprint])).digest('hex');
    return `ws/${workspace}/change/${hash}`;
  });
  const generated = db.prepare(`SELECT c.id, p.value ->> '$.key' AS key FROM repository_generations g
    JOIN json_each(g.proposal, '$.concepts') p
    JOIN concepts c ON c.key = delve_v10_change_key(g.workspace_id, g.snapshot_id, p.value ->> '$.key',
      p.value ->> '$.title', p.value ->> '$.summary', p.value ->> '$.portable')
    JOIN snapshot_concepts sc ON sc.snapshot_id = g.snapshot_id AND sc.concept_id = c.id
    WHERE g.id = ? ORDER BY p.key`);
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
    const footprints = generated.all(id).map(({ id, key }) => {
      assert.ok(typeof id === 'number' && typeof key === 'string');
      const concept = getConcept(db, id);
      assert.ok(concept && concept.workspaceId === workspaceId);
      return { concept, key };
    });
    const title = typeof plainTitle === 'string' ? plainTitle
      : typeof sourceTitle === 'string' ? plainConceptTitle(sourceTitle) : overview.title;
    return { workspaceId, change: changeIdentity(kind, kind === 'commit' ? head : ref, base, head), overview,
      title: depth === 'high' ? title : (typeof sourceTitle === 'string' ? sourceTitle : overview.title), footprints };
  });
}

export function reconcileSavedChanges(db: Db): void {
  assert.ok(db.isTransaction);
  const changes = readSavedChanges(db);
  const owner = new Map<number, string | null>();
  for (const scope of changes) {
    for (const { concept } of scope.footprints) {
      const prior = owner.get(concept.id);
      owner.set(concept.id, prior === undefined || prior === scope.change ? scope.change : null);
    }
  }

  const aliases = new Set<number>();
  for (const scope of changes) {
    const canonical = findChangeConcept(db, scope, overviewKey) ?? scope.overview;
    if (scope.overview.id !== canonical.id && !aliases.has(scope.overview.id)) {
      linkChangeDuplicate(db, scope.overview, canonical);
      aliases.add(scope.overview.id);
    }
    rememberChangeConcept(db, scope, canonical, overviewKey);
    rememberChangeConcept(db, scope, canonical, changeTitleKey(scope.title), changeTitleKey(scope.overview.title));
  }
  for (const scope of changes) {
    for (const { concept, key } of scope.footprints) {
      if (owner.get(concept.id) !== scope.change) continue;
      const keys = [changeProviderKey(key), changeTitleKey(concept.title)];
      const canonical = findChangeConcept(db, scope, ...keys) ?? concept;
      assert.ok(!aliases.has(canonical.id), 'resolved change identities must be canonical');
      if (canonical.id !== concept.id && !aliases.has(concept.id)) {
        linkChangeDuplicate(db, concept, canonical);
        aliases.add(concept.id);
      }
      rememberChangeConcept(db, scope, canonical, ...keys);
    }
  }
}
