import { Fragment, useId } from 'react';
import type { DiagramEdge } from '../../../shared/lesson-blocks';
import { layoutDiagram } from './diagram-layout';

export function Diagram({ nodes, edges }: { nodes: string[]; edges?: DiagramEdge[] }) {
  const caption = useId();
  const layout = layoutDiagram(nodes, edges);
  const columns = ['minmax(10rem, 16rem)', ...layout.lanes.map(lane => lane.labeled ? 'var(--diagram-label-lane)' : '1.75rem')];
  return <figure className="chapter lesson-diagram">
    <figcaption id={caption} className="plate">System trace</figcaption>
    <div className="lesson-diagram-scroll" role="region" aria-labelledby={caption} tabIndex={0}>
      <div className="lesson-diagram-grid" style={{ gridTemplateColumns: columns.join(' ') }} aria-hidden="true">
        {layout.order.map((node, row) => {
          const edge = layout.direct.get(row);
          return <Fragment key={node}>
            <div className="lesson-diagram-node" dir="auto" style={{ gridRow: `${4 * row + 1} / span 3` }}>
              {nodes[node]}
            </div>
            {edge && <div className="lesson-diagram-direct" style={{ gridRow: 4 * row + 4 }}>
              {edge.label && <span dir="auto">{edge.label}</span>}
            </div>}
          </Fragment>;
        })}
        {layout.routed.map(({ edge, lane, start, end, returns }) =>
          <div className="lesson-diagram-branch" data-returns={returns} key={JSON.stringify([edge.from, edge.to, edge.label])}
            style={{ gridRow: `${start} / ${end}`, gridColumn: `2 / ${lane + 3}` }}>
            {edge.label && <span dir="auto">{edge.label}</span>}
          </div>)}
      </div>
      <div className="sr-only">
        <ul aria-label="Nodes">{layout.order.map(node => <li key={node}>{nodes[node]}</li>)}</ul>
        {layout.edges.length > 0 && <ul aria-label="Connections">
          {layout.edges.map(({ from, to, label }, index) => <li key={index}>
            {nodes[from]} to {nodes[to]}{label && ` (${label})`}
          </li>)}
        </ul>}
      </div>
    </div>
  </figure>;
}
