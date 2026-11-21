import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addPrerequisite, upsertConcept } from './concepts';
import { openDatabase, type Db } from './connection';
import { recordEvidence } from './evidence';
import { createTransferLink, deleteTransferLink, getGlobalKnowledgeGraph } from './knowledge';
import { addWorkspace } from './workspaces';
import { seedDemoWorkspaces } from './demo';

let db: Db;
let alpha: string;
let beta: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  alpha = addWorkspace(db, { kind: 'topic', title: 'Alpha' }).id;
  beta = addWorkspace(db, { kind: 'topic', title: 'Beta' }).id;
});
afterEach(() => db.close());

const link = (from: number, to: number, extra: object = {}) =>
  ({ fromConceptId: from, toConceptId: to, reason: 'Same idea', provider: 'claude', model: 'm1', ...extra });

describe('global knowledge graph', () => {
  it('deduplicates shared concepts, marks bridges and keeps local ones single-workspace', () => {
    const shared = upsertConcept(db, { key: 'queue', title: 'Queue', portable: true, workspaceId: alpha });
    upsertConcept(db, { key: 'queue', title: 'Queue', portable: true, workspaceId: beta });
    const local = upsertConcept(db, { key: 'lease', title: 'Lease', portable: false, workspaceId: alpha });
    addPrerequisite(db, local.id, shared.id);
    db.prepare('INSERT INTO workspace_concepts (workspace_id, concept_id) VALUES (?, ?)').run(beta, local.id);

    const graph = getGlobalKnowledgeGraph(db);
    expect(graph.concepts.map((c) => c.id)).toEqual([shared.id, local.id]);
    expect(graph.concepts[0]).toMatchObject({ bridge: true, masteredDepth: null, learnedAt: null });
    expect(graph.concepts[0]!.memberships.map((m) => m.workspaceName)).toEqual(['Alpha', 'Beta']);
    expect(graph.concepts[1]).toMatchObject({ bridge: false, memberships: [{ workspaceId: alpha, workspaceName: 'Alpha' }] });
    expect(graph.edges).toEqual([{ conceptId: local.id, prerequisiteId: shared.id }]);
  });

  it('counts only verified demonstrated evidence and reports the deepest depth', () => {
    const c = upsertConcept(db, { key: 'cache', title: 'Cache', portable: true, workspaceId: alpha });
    recordEvidence(db, { conceptId: c.id, depth: 'high', status: 'demonstrated', source: 'check', masteryVerified: true, workspaceId: alpha });
    recordEvidence(db, { conceptId: c.id, depth: 'low', status: 'demonstrated', source: 'environment', workspaceId: alpha });
    const [verifiedHigh] = getGlobalKnowledgeGraph(db).concepts;
    expect(verifiedHigh!.masteredDepth).toBe('high');
    expect(verifiedHigh!.learnedAt).not.toBeNull();

    recordEvidence(db, { conceptId: c.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true, workspaceId: alpha });
    expect(getGlobalKnowledgeGraph(db).concepts[0]!.masteredDepth).toBe('medium');
  });

  it('reports in-progress, skipped and not-started lesson states with the evidence revision', () => {
    const [a, b, c, d] = (['a', 'b', 'c', 'd'] as const).map((key) => upsertConcept(db, { key, title: key, portable: true, workspaceId: alpha }));
    const stage = db.prepare("INSERT INTO lesson_mastery (workspace_id, concept_id, depth, scope, revision, state) VALUES (?, ?, 'medium', 's', 'r', ?)");
    stage.run(alpha, a!.id, JSON.stringify({ stage: 'checking' }));
    stage.run(alpha, b!.id, JSON.stringify({ stage: 'skipped' }));
    for (let i = 0; i < 2; i += 1) {
      recordEvidence(db, { conceptId: d!.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true, workspaceId: alpha });
    }
    const states = getGlobalKnowledgeGraph(db).concepts.map((x) => [x.masteryState, x.evidenceRevision]);
    expect(states).toEqual([['in-progress', null], ['skipped', null], ['not-started', null], ['verified', 2]]);
    expect(c!.id).toBeGreaterThan(0);
  });

  it('omits concepts that no workspace uses', () => {
    const c = upsertConcept(db, { key: 'gone', title: 'Gone', portable: true, workspaceId: alpha });
    db.prepare('DELETE FROM workspace_concepts WHERE concept_id = ?').run(c.id);
    expect(getGlobalKnowledgeGraph(db).concepts).toEqual([]);
  });

  it('keeps demo evidence out of a learner’s global record', () => {
    seedDemoWorkspaces(db);
    expect(getGlobalKnowledgeGraph(db).concepts).toEqual([]);
    const learned = upsertConcept(db, { key: 'real', title: 'Real concept', portable: true, workspaceId: alpha });
    expect(getGlobalKnowledgeGraph(db).concepts.map(concept => concept.id)).toEqual([learned.id]);
  });

});

describe('global graph performance', () => {
  it('handles 2000 concepts and 5000 edges within budget', () => {
    const insert = db.prepare('INSERT INTO concepts (key, title, portable, created_at, updated_at) VALUES (?, ?, 1, ?, ?)');
    const member = db.prepare('INSERT INTO workspace_concepts (workspace_id, concept_id) VALUES (?, ?)');
    const edge = db.prepare('INSERT INTO concept_edges (concept_id, prerequisite_id, created_at) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < 2000; i += 1) {
      const id = Number(insert.run(`n${i}`, `Node ${i}`, 'now', 'now').lastInsertRowid);
      member.run(i % 2 === 0 ? alpha : beta, id);
      if (i % 3 === 0) member.run(i % 2 === 0 ? beta : alpha, id);
    }
    let edgeCount = 0;
    for (let id = 4; id <= 2000 && edgeCount < 5000; id += 1) {
      for (let offset = 1; offset <= 3 && edgeCount < 5000; offset += 1, edgeCount += 1) edge.run(id, id - offset, 'now');
    }
    expect(edgeCount).toBe(5000);
    db.exec('COMMIT');
    const started = performance.now();
    const graph = getGlobalKnowledgeGraph(db);
    const elapsed = performance.now() - started;
    expect(graph.concepts).toHaveLength(2000);
    expect(graph.edges).toHaveLength(5000);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('transfer links', () => {
  it('persists model, provenance and reason and appears in the graph', () => {
    const a = upsertConcept(db, { key: 'a', title: 'A', portable: true, workspaceId: alpha });
    const b = upsertConcept(db, { key: 'b', title: 'B', portable: true, workspaceId: beta });
    const created = createTransferLink(db, link(a.id, b.id, { reason: '  Both retry  ', workspaceId: alpha }));
    expect(created).toMatchObject({ fromConceptId: a.id, toConceptId: b.id, reason: 'Both retry', provider: 'claude', model: 'm1', workspaceId: alpha });
    expect(getGlobalKnowledgeGraph(db).links).toEqual([created]);
    expect(deleteTransferLink(db, created.id)).toBe(true);
    expect(deleteTransferLink(db, created.id)).toBe(false);
    expect(getGlobalKnowledgeGraph(db).links).toEqual([]);
  });

  it('rejects self links, unknown endpoints, duplicates in either direction and blank fields', () => {
    const a = upsertConcept(db, { key: 'a', title: 'A', portable: true, workspaceId: alpha });
    const b = upsertConcept(db, { key: 'b', title: 'B', portable: true, workspaceId: alpha });
    expect(() => createTransferLink(db, link(a.id, a.id))).toThrow(/itself/);
    expect(() => createTransferLink(db, link(a.id, 9999))).toThrow(/does not exist/);
    expect(() => createTransferLink(db, link(a.id, b.id, { workspaceId: 'nope' }))).toThrow(/no longer exists/);
    expect(() => createTransferLink(db, link(a.id, b.id, { reason: ' ' }))).toThrow(/reason/);
    expect(() => createTransferLink(db, link(a.id, b.id, { model: '' }))).toThrow(/model/);
    createTransferLink(db, link(a.id, b.id));
    expect(() => createTransferLink(db, link(b.id, a.id))).toThrow(/already linked/);
    expect(db.isTransaction).toBe(false);
  });
});
