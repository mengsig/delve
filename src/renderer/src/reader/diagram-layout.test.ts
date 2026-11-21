import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TeachingBlock } from './Blocks';
import { layoutDiagram } from './diagram-layout';

describe('lesson diagrams', () => {
  it('renders the Run, Agent, and Task in flow order with accessible directed relationships', () => {
    const markup = renderToStaticMarkup(createElement(TeachingBlock, {
      blockIndex: 0,
      block: {
        type: 'diagram',
        nodes: ['Task', 'Agent', 'Run'],
        edges: [{ from: 2, to: 1, label: 'groups' }, { from: 1, to: 0, label: 'works on' }],
      },
    }));
    const [visual] = markup.split('class="sr-only"');
    expect(visual?.match(/class="lesson-diagram-node"/g)).toHaveLength(3);
    expect(visual).toMatch(/>Run<.*>groups<.*>Agent<.*>works on<.*>Task</);
    expect(markup).toContain('Run to Agent (groups)');
    expect(markup).toContain('Agent to Task (works on)');
  });

  it('routes cycles, parallel edges, and loops while keeping the isolated node', () => {
    const edges = [
      { from: 0, to: 1 },
      { from: 0, to: 1, label: 'retries' },
      { from: 1, to: 0 },
      { from: 1, to: 1, label: 'waits' },
    ];
    const { order, direct, routed, lanes } = layoutDiagram(['A', 'B', 'Isolated'], edges);
    expect(order).toEqual([2, 0, 1]);
    expect([...direct.values()]).toEqual([edges[0]]);
    expect(routed.map(({ edge, returns }) => [edge, returns])).toEqual([
      [edges[2], true], [edges[1], false], [edges[3], true],
    ]);
    expect(lanes).toHaveLength(3);
    expect(new Set(routed.map(branch => branch.lane)).size).toBe(3);
  });

  it('uses an implicit chain only when edges are omitted', () => {
    const nodes = ['Depot', 'Station', 'Garage'];
    expect(layoutDiagram(nodes).edges).toEqual([{ from: 0, to: 1 }, { from: 1, to: 2 }]);
    const isolated = layoutDiagram(nodes, []);
    expect(isolated.order).toEqual([0, 1, 2]);
    expect(isolated.edges).toEqual([]);
  });
});
