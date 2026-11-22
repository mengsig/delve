import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addPrerequisite, upsertConcept } from './concepts';
import { openDatabase, type Db } from './connection';
import { recordEvidence, resetEvidence } from './evidence';
import { readWorkspaceCoverage, readWorkspaceGraph } from './graph';
import { bindSnapshot } from './lessons';
import { addWorkspace } from './workspaces';

let db: Db;
let first: string;
let second: string;
let empty: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  first = addWorkspace(db, { kind: 'topic', title: 'First' }).id;
  second = addWorkspace(db, { kind: 'topic', title: 'Second' }).id;
  empty = addWorkspace(db, { kind: 'topic', title: 'Empty' }).id;
});

afterEach(() => db.close());

describe('workspace graph and coverage', () => {
  it('uses scoped concepts, linked edges, exact depths and named provenance', () => {
    const shared = upsertConcept(db, { key: 'queue', title: 'Queue', portable: true, workspaceId: first });
    upsertConcept(db, { key: 'queue', title: 'Queue', portable: true, workspaceId: second });
    const privateConcept = upsertConcept(db, { key: 'lease', title: 'Lease', portable: false, workspaceId: first });
    const unlinked = upsertConcept(db, { key: 'clock', title: 'Clock', portable: true, workspaceId: second });
    addPrerequisite(db, privateConcept.id, shared.id);
    addPrerequisite(db, shared.id, unlinked.id);
    recordEvidence(db, { conceptId: shared.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true, workspaceId: second });
    recordEvidence(db, { conceptId: shared.id, depth: 'low', status: 'partial', source: 'self-report', workspaceId: first });
    recordEvidence(db, { conceptId: privateConcept.id, depth: 'high', status: 'demonstrated', source: 'environment' });
    // A stray membership cannot give another workspace access to a local concept.
    db.prepare('INSERT INTO workspace_concepts (workspace_id, concept_id) VALUES (?, ?)').run(second, privateConcept.id);

    const graph = readWorkspaceGraph(db, first);
    expect(graph.concepts.map(({ id }) => id)).toEqual([shared.id, privateConcept.id]);
    expect(graph.edges).toEqual([{ conceptId: privateConcept.id, prerequisiteId: shared.id }]);
    expect(graph.evidence).toEqual([
      expect.objectContaining({ conceptId: shared.id, depth: 'medium', status: 'demonstrated', workspaceId: second, workspaceName: 'Second' }),
      expect.objectContaining({ conceptId: shared.id, depth: 'low', status: 'partial', workspaceId: first, workspaceName: 'First' }),
      expect.objectContaining({ conceptId: privateConcept.id, depth: 'high', status: 'revisit', workspaceId: first, workspaceName: 'First' }),
    ]);
    const secondGraph = readWorkspaceGraph(db, second);
    expect(secondGraph.concepts.map(({ id }) => id)).toEqual([shared.id, unlinked.id]);
    expect(secondGraph.edges).toEqual([{ conceptId: shared.id, prerequisiteId: unlinked.id }]);
    expect(secondGraph.evidence.every((row) => row.conceptId === shared.id)).toBe(true);
    expect(readWorkspaceCoverage(db)).toEqual([
      { workspaceId: first, total: 2, known: { high: 1, medium: 1, low: 0 } },
      { workspaceId: second, total: 2, known: { high: 1, medium: 1, low: 0 } },
      { workspaceId: empty, total: 0, known: { high: 0, medium: 0, low: 0 } },
    ]);
  });

  it('returns the latest workspace snapshot and distinguishes empty from missing', () => {
    bindSnapshot(db, first, 'aaaaaaa');
    bindSnapshot(db, first, 'bbbbbbb');
    bindSnapshot(db, second, 'ccccccc');
    expect(readWorkspaceGraph(db, first)).toMatchObject({ snapshot: 'bbbbbbb', demo: false });
    expect(readWorkspaceGraph(db, second).snapshot).toBe('ccccccc');
    expect(readWorkspaceGraph(db, empty)).toEqual({
      workspaceId: empty, snapshot: null, demo: false, concepts: [], edges: [], evidence: [],
    });
    expect(() => readWorkspaceGraph(db, 'missing')).toThrow(/no longer exists/);
  });
});

describe('portable evidence reset', () => {
  it('requires a linked origin, fails atomically and updates every linked read', () => {
    const concept = upsertConcept(db, { key: 'queue', title: 'Queue', portable: true, workspaceId: first });
    upsertConcept(db, { key: 'queue', title: 'Queue', portable: true, workspaceId: second });
    recordEvidence(db, { conceptId: concept.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true, workspaceId: second });
    recordEvidence(db, { conceptId: concept.id, depth: 'high', status: 'demonstrated', source: 'check', workspaceId: first });

    expect(() => resetEvidence(db, concept.id, { workspaceId: empty, depth: 'medium' })).toThrow(/not linked/);
    expect(() => resetEvidence(db, concept.id, { workspaceId: 'missing', depth: 'medium' })).toThrow(/no longer exists/);
    expect(() => resetEvidence(db, concept.id, { workspaceId: first })).toThrow(/where it was recorded/);
    expect(readWorkspaceGraph(db, first).evidence.map(({ depth }) => depth)).toEqual(['high', 'medium']);
    expect(resetEvidence(db, concept.id, { workspaceId: second, depth: 'medium' })).toBe(1);
    expect(resetEvidence(db, concept.id, { workspaceId: second, depth: 'medium' })).toBe(0);
    expect(readWorkspaceGraph(db, first).evidence.map(({ depth }) => depth)).toEqual(['high']);
    expect(readWorkspaceGraph(db, second).evidence.map(({ depth }) => depth)).toEqual(['high']);
  });

  it('allows a linked workspace to reset portable evidence whose origin was deleted', () => {
    const concept = upsertConcept(db, { key: 'queue', title: 'Queue', portable: true, workspaceId: first });
    upsertConcept(db, { key: 'queue', title: 'Queue', portable: true, workspaceId: second });
    recordEvidence(db, { conceptId: concept.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true, workspaceId: second });
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(second);
    expect(readWorkspaceGraph(db, first).evidence).toMatchObject([{ workspaceId: null, workspaceName: null }]);
    expect(() => resetEvidence(db, concept.id, { workspaceId: empty, depth: 'medium' })).toThrow(/not linked/);
    expect(resetEvidence(db, concept.id, { workspaceId: first, depth: 'medium' })).toBe(1);
    expect(readWorkspaceGraph(db, first).evidence).toEqual([]);
  });
});

it('links a portable record to its origin so it can be inspected and reset there', () => {
  const shared = upsertConcept(db, { portable: true, key: 'field-of-view', title: 'Field of view' });
  recordEvidence(db, { workspaceId: first, conceptId: shared.id, depth: 'medium', status: 'partial', source: 'self-report' });
  const graph = readWorkspaceGraph(db, first);
  expect(graph.evidence).toMatchObject([{ conceptId: shared.id, workspaceId: first }]);
  expect(graph.concepts).toMatchObject([{ id: shared.id, portable: true }]);
  expect(resetEvidence(db, shared.id, { workspaceId: first, depth: 'medium' })).toBe(1);
});
