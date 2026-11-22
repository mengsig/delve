import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlobalKnowledgeGraph, KnowledgeConcept } from '../../../shared/knowledge';
import { fitViewport, readViewport, revealPoint, writeViewport, zoomAt } from './map-camera';
import { drawGraph, prepareDrawData } from './map-drawing';
import { directionalPoint, overlaps, project } from './map-geometry';
import { pickNode, placeLabels } from './map-labels';
import { layoutGraph, type Point } from './map-layout';

function concept(id: number, workspaceIds: string[] = []): KnowledgeConcept {
  return { id, key: String(id), title: `Node ${id}`, summary: '', portable: false,
    memberships: workspaceIds.map(workspaceId => ({ workspaceId, workspaceName: workspaceId })),
    masteredDepth: null, masteryState: 'not-started', evidenceRevision: null, learnedAt: null,
    learnedWorkspaceId: null, bridge: workspaceIds.length > 1 };
}

function canvasFixture() {
  const ctx = {
    setTransform: vi.fn(), clearRect: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), bezierCurveTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    fillText: vi.fn(), roundRect: vi.fn(), measureText: vi.fn(() => ({ width: 40 })),
  };
  const canvas = { width: 0, height: 0, getBoundingClientRect: () => ({ width: 320, height: 170 }),
    getContext: () => ctx } as unknown as HTMLCanvasElement;
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#28543c' }));
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('document', { documentElement: { dataset: { theme: 'light' } } });
  return { canvas, ctx };
}

function graphFixture(points: Point[], edges: GlobalKnowledgeGraph['edges'] = []): GlobalKnowledgeGraph {
  return { concepts: points.map(point => concept(point.id)), edges, links: [] };
}

function drawFixture(points: Point[], scale: number, edges: GlobalKnowledgeGraph['edges'] = []) {
  const { canvas, ctx } = canvasFixture();
  const data = prepareDrawData(graphFixture(points, edges), { points, areas: [] });
  const measurements = new Map<string, { text: string; width: number }>();
  const draw = () => drawGraph(canvas, data, { x: 0, y: 0, scale }, { states: new Map(), visible: new Set(points.map(point => point.id)),
    focus: null, selected: null, preview: null }, measurements);
  return { draw, ctx };
}

describe('map canvas', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('culls distant nodes, preserves clipped bodies, and reuses label measurements', () => {
    const points = [{ id: 1, x: -16, y: 100 }, { id: 2, x: 200, y: 100 }, { id: 3, x: 1300, y: 100 }];
    const { draw, ctx } = drawFixture(points, .55);
    const hits = draw();
    expect(hits.map(hit => hit.id)).toEqual([1, 2]);
    expect(hits[1]?.label).toBeDefined();
    expect(ctx.fillText).toHaveBeenCalledWith('Node 2', expect.any(Number), expect.any(Number));
    expect(ctx.measureText).toHaveBeenCalledTimes(2);
    draw();
    expect(ctx.measureText).toHaveBeenCalledTimes(2);
  });

  it('omits labels below the threshold and retains curves that cross the canvas', () => {
    const points = [{ id: 1, x: -350, y: 100 }, { id: 2, x: 1020, y: 100 }, { id: 3, x: -460, y: 150 }];
    const edges = [{ prerequisiteId: 1, conceptId: 2 }, { prerequisiteId: 1, conceptId: 3 }];
    const { draw, ctx } = drawFixture(points, .549, edges);
    expect(draw()).toEqual([]);
    expect(ctx.arc).not.toHaveBeenCalled();
    expect(ctx.measureText).not.toHaveBeenCalled();
    expect(ctx.moveTo).toHaveBeenCalledExactlyOnceWith(-350, 100);
    expect(ctx.bezierCurveTo).toHaveBeenCalledExactlyOnceWith(
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number), 1020, 100,
    );
  });

  it('places labels away from neighboring bodies and makes the label clickable', () => {
    const first = { id: 1, title: 'Queue', x: 100, y: 70, radius: 13 };
    const second = { id: 2, title: 'Lease', x: 105, y: 105, radius: 13 };
    const screen = { top: 0, right: 220, bottom: 190, left: 0 };
    const labels = placeLabels([first, second], screen, text => ({ text, width: 85 }));
    const firstLabel = labels.get(first.id)!.bounds;
    expect(firstLabel.bottom).toBeLessThan(first.y - first.radius);
    expect(overlaps(firstLabel, labels.get(second.id)!.bounds)).toBe(false);
    expect(pickNode([{ ...first, label: firstLabel }, second], first.x, firstLabel.top + 4)).toBe(first.id);
    expect(pickNode([first, second], 200, 70)).toBeNull();
  });
});

describe('map layout and camera', () => {
  it('groups workspaces stably and places prerequisite ranks in sequence', () => {
    const concepts = [concept(1, ['a']), concept(2, ['b', 'a']), concept(3, ['a']), concept(4, ['b'])];
    const edges = [{ prerequisiteId: 1, conceptId: 2 }, { prerequisiteId: 2, conceptId: 3 }];
    const layout = layoutGraph({ concepts, edges });
    expect(layoutGraph({ concepts: concepts.toReversed(), edges: edges.toReversed() })).toEqual(layout);
    expect(layout.areas.map(area => area.title)).toEqual(['a', 'b']);
    const byId = new Map(layout.points.map(point => [point.id, point]));
    expect(byId.get(1)!.x).toBeLessThan(byId.get(2)!.x);
    expect(byId.get(2)!.x).toBeLessThan(byId.get(3)!.x);
    expect(byId.get(2)!.x).toBeLessThan(layout.areas[0]!.right);
  });

  it('assigns one finite position per concept when a graph has a cycle or missing endpoint', () => {
    const layout = layoutGraph({ concepts: [concept(1), concept(2)], edges: [
      { prerequisiteId: 1, conceptId: 2 }, { prerequisiteId: 2, conceptId: 1 }, { prerequisiteId: 9, conceptId: 1 },
    ] });
    expect(layout.points.map(point => point.id)).toEqual([1, 2]);
    expect(layout.points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    expect(() => layoutGraph({ concepts: [concept(1), concept(1)], edges: [] })).toThrow(/unique/);
  });

});

describe('map camera', () => {
  it('fits the intended points and preserves the zoom anchor', () => {
    const points = [{ id: 1, x: -420, y: 2100 }, { id: 2, x: -100, y: 2280 }];
    const view = fitViewport(points, { width: 480, height: 370 });
    const anchor = project(points[0]!, view);
    expect(anchor.x).toBeGreaterThan(50);
    expect(anchor.y).toBeGreaterThan(50);
    const zoomed = project(points[0]!, zoomAt(view, 1.7, anchor.x, anchor.y));
    expect(zoomed.x).toBeCloseTo(anchor.x);
    expect(zoomed.y).toBeCloseTo(anchor.y);
    expect(revealPoint(view, points[1]!, { width: 480, height: 370 })).toBe(view);
    const offscreen = { id: 3, x: -2000, y: 3000 };
    expect(project(offscreen, revealPoint(view, offscreen, { width: 480, height: 370 }))).toEqual({ x: 240, y: 185 });
  });

  it('stores cameras independently and rejects unscoped, malformed, or obsolete values', () => {
    const entries = new Map<string, string>();
    const storage = { getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value) } as unknown as Storage;
    const key = 'delve.knowledge.viewport';
    const first = { x: 10, y: 20, scale: .9 };
    const second = { x: 40, y: -300, scale: .2 };
    entries.set(key, JSON.stringify(first));
    expect(readViewport(storage, 'demo')).toBeNull();
    writeViewport(storage, 'demo', first);
    writeViewport(storage, 'personal', second);
    expect(readViewport(storage, 'demo')).toEqual(first);
    expect(readViewport(storage, 'personal')).toEqual(second);
    expect(JSON.parse(entries.get(key)!)).toEqual(second);
    entries.set(`${key}.demo`, '{broken');
    expect(readViewport(storage, 'demo')).toBeNull();
    entries.set(`${key}.demo`, JSON.stringify({ ...first, version: 0 }));
    expect(readViewport(storage, 'demo')).toBeNull();
    expect(() => writeViewport(storage, 'demo', { ...first, scale: 4 })).toThrow(/invalid/);
  });

  it('picks the nearest concept in the direction of keyboard travel', () => {
    const origin = { id: 1, x: 150, y: 30 };
    const points = [origin, { id: 2, x: 160, y: 100 }, { id: 3, x: 230, y: 30 }, { id: 4, x: 130, y: 30 }];
    expect(directionalPoint(points, origin, 1, 0)?.id).toBe(3);
    expect(directionalPoint(points, origin, 0, 1)?.id).toBe(2);
    expect(directionalPoint(points, origin, 0, -1)).toBeUndefined();
  });
});
