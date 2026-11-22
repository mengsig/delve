import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlobalKnowledgeGraph, KnowledgeConcept } from '../../../shared/knowledge';
import { drawGraph, prepareDrawData } from './KnowledgeMap';

function concept(id: number): KnowledgeConcept {
  return { id, key: String(id), title: `Node ${id}`, summary: '', portable: false, memberships: [],
    masteredDepth: null, masteryState: 'not-started', evidenceRevision: null, learnedAt: null,
    learnedWorkspaceId: null, bridge: true };
}

function canvasFixture(scale: number) {
  const ctx = {
    setTransform: vi.fn(), clearRect: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillText: vi.fn(),
    measureText: vi.fn(() => ({ actualBoundingBoxLeft: 0, actualBoundingBoxRight: 40,
      actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 })),
  };
  const canvas = { width: 0, height: 0, getBoundingClientRect: () => ({ width: 100 * scale, height: 100 * scale }),
    getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, ctx };
}

describe('knowledge graph culling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps partial rings and bodies, and labels at the zoom threshold', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('getComputedStyle', () => ({ color: '#000' }));
    const points = [{ id: 1, x: -16, y: 50 }, { id: 2, x: 105, y: 50 },
      { id: 3, x: -40, y: 50 }, { id: 4, x: -80, y: 50 }];
    const graph: GlobalKnowledgeGraph = { concepts: points.map(point => concept(point.id)), edges: [], links: [] };
    const data = prepareDrawData(graph, points);
    const { canvas, ctx } = canvasFixture(.55);
    drawGraph(canvas, data, { x: 0, y: 0, scale: .55 }, new Set(points.map(point => point.id)), null, null);
    expect(ctx.arc.mock.calls.map(call => [call[0], call[1]])).toEqual([
      [-16, 50], [-16, 50], [105, 50], [105, 50], [-40, 50], [-40, 50],
    ]);
    expect(ctx.fillText.mock.calls.map(call => call[0])).toEqual(['Node 1', 'Node 2', 'Node 3']);
    expect(ctx.measureText).toHaveBeenCalledTimes(4);
    drawGraph(canvas, data, { x: 0, y: 0, scale: .55 }, new Set(points.map(point => point.id)), null, null);
    expect(ctx.measureText).toHaveBeenCalledTimes(4);
  });

  it('culls label-only overlap below the label threshold and keeps crossing edges', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('getComputedStyle', () => ({ color: '#000' }));
    const points = [{ id: 1, x: -40, y: 50 }, { id: 2, x: 140, y: 50 }, { id: 3, x: -80, y: 120 }];
    const graph: GlobalKnowledgeGraph = { concepts: points.map(point => concept(point.id)),
      edges: [{ prerequisiteId: 1, conceptId: 2 }, { prerequisiteId: 1, conceptId: 3 }], links: [] };
    const { canvas, ctx } = canvasFixture(.549);
    drawGraph(canvas, prepareDrawData(graph, points), { x: 0, y: 0, scale: .549 },
      new Set(points.map(point => point.id)), null, null);
    expect(ctx.arc).not.toHaveBeenCalled();
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.measureText).not.toHaveBeenCalled();
    expect(ctx.moveTo).toHaveBeenCalledOnce();
    expect(ctx.lineTo).toHaveBeenCalledWith(140, 50);
  });
});
