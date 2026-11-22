import { describe, expect, it } from 'vitest';
import type { GraphEvidence, WorkspaceGraph } from '../../../shared/graph';
import { demoPlate } from './demoAtlas';
import { positions } from './layout';
import { buildAtlas, nextConcept, statusText } from './model';

function graph(): WorkspaceGraph {
  return {
    workspaceId: 'here', snapshot: null, demo: false,
    concepts: [
      { id: 1, key: 'queue', title: 'Queue', summary: 'Store work.', portable: true },
      { id: 2, key: 'clock', title: 'Clock', summary: 'Measure time.', portable: true },
      { id: 3, key: 'here:lease', title: 'Lease', summary: 'Claim work.', portable: false },
      { id: 4, key: 'here:fence', title: 'Fence', summary: 'Check ownership.', portable: false },
    ],
    edges: [{ prerequisiteId: 1, conceptId: 3 }, { prerequisiteId: 2, conceptId: 3 }, { prerequisiteId: 3, conceptId: 4 }],
    evidence: [],
  };
}

function evidence(conceptId: number, update: Partial<GraphEvidence> = {}): GraphEvidence {
  return {
    conceptId, depth: 'medium', status: 'demonstrated', source: 'check', note: '',
    workspaceId: 'here', workspaceName: 'Here', revision: 1, recordedAt: '2026-01-01T00:00:00Z', ...update,
  };
}

describe('Atlas graph projection', () => {
  it('groups concepts by prerequisite depth and indexes both directions', () => {
    const model = buildAtlas(graph(), 'medium');
    expect(model.layers.map(layer => layer.map(c => c.id))).toEqual([[1, 2], [3], [4]]);
    expect(model.byId.get(3)?.prerequisites.map(c => c.id)).toEqual([1, 2]);
    expect(model.byId.get(3)?.dependents.map(c => c.id)).toEqual([4]);
  });

  it('uses deeper portable evidence and requires an exact depth for local evidence', () => {
    const data = graph();
    data.evidence = [
      evidence(1, { workspaceId: 'there', workspaceName: 'There' }),
      evidence(2, { depth: 'low' }), evidence(3, { status: 'partial' }), evidence(3, { depth: 'low' }),
    ];
    const model = buildAtlas(data, 'medium');
    expect(model.learned).toBe(2);
    expect(statusText(model.byId.get(1)!, 'here')).toBe('Known from There');
    expect(statusText(model.byId.get(3)!, 'here')).toBe('Partially demonstrated');
    expect(nextConcept(model)?.id).toBe(3);
    expect(buildAtlas(data, 'low').byId.get(1)?.evidence).toBeUndefined();
    data.evidence.push(evidence(2, { status: 'partial' }));
    expect(buildAtlas(data, 'medium').byId.get(2)?.evidence?.depth).toBe('low');
  });

  it('selects a ready follow-up before another missing foundation and makes fully learned paths optional', () => {
    const data = graph();
    data.evidence = [evidence(2, { status: 'revisit' })];
    expect(nextConcept(buildAtlas(data, 'medium'))?.id).toBe(2);
    data.evidence = data.concepts.map(c => evidence(c.id));
    const model = buildAtlas(data, 'medium');
    expect(model.learned).toBe(model.byId.size);
    expect(nextConcept(model, model.byId.get(3))?.id).toBe(3);
  });

  it('rejects cycles, missing endpoints, repeated evidence and foreign local evidence', () => {
    const data = graph();
    expect(() => buildAtlas({ ...data, edges: [...data.edges, { prerequisiteId: 4, conceptId: 1 }] }, 'low')).toThrow('cycle');
    expect(() => buildAtlas({ ...data, edges: [{ prerequisiteId: 98, conceptId: 2 }] }, 'low')).toThrow('outside');
    expect(() => buildAtlas({ ...data, evidence: [evidence(1), evidence(1)] }, 'medium')).toThrow('Duplicate evidence');
    expect(() => buildAtlas({ ...data, evidence: [evidence(3, { workspaceId: 'there' })] }, 'medium')).toThrow('different workspace');
  });

  it('retains empty and disconnected workspaces and lays out each node once', () => {
    const empty = buildAtlas({ ...graph(), concepts: [], edges: [] }, 'high');
    expect(nextConcept(empty)).toBeUndefined();
    expect(positions(empty, 500, 200).size).toBe(0);
    const model = buildAtlas({ ...graph(), edges: [] }, 'high');
    expect(new Set(Array.from(positions(model, 500, 200).values(), p => p.y)).size).toBe(4);
    expect(() => positions(model, 0, 200)).toThrow('viewport');
  });

  it('uses proposal coordinates by key only for explicit demo workspaces', () => {
    const data = graph();
    const model = buildAtlas(data, 'medium');
    expect(demoPlate(data, model)).toBeUndefined();
    const demo = demoPlate({ ...data, demo: true }, model);
    expect(demo?.changed?.id).toBe(4);
    const lease = positions(model, 1000, 250, demo).get(3);
    expect(lease?.x).toBeCloseTo(458);
    expect(lease?.y).toBeCloseTo(115);
    const generic = positions(model, 1000, 250);
    expect(generic.get(1)!.x).toBeLessThan(generic.get(3)!.x);
    expect(generic.get(3)!.x).toBeLessThan(generic.get(4)!.x);
  });
});
