import type { HistoryNode } from '../../../shared/explorer';
import { OVERFLOW_LANE, type LaneRow, type Segment } from './lanes';

export const ROW_HEIGHT = 56;
const middle = ROW_HEIGHT / 2;
const coordinate = (lane: number) => 8 + lane * 12;

export function graphWidth(layout?: LaneRow[]) {
  let lane = 0;
  for (const row of layout ?? []) {
    lane = Math.max(lane, row.lane);
    for (const edge of row.segments) lane = Math.max(lane, edge.from, edge.to);
    if (lane === OVERFLOW_LANE) return 86;
  }
  return coordinate(lane) + 8;
}

function route({ from, to, span }: Segment) {
  const start = coordinate(from);
  const end = coordinate(to);
  if (span === 'through') return `M${start} 0 V${ROW_HEIGHT}`;
  if (span === 'incoming') return `M${start} 0 V${middle}`;
  if (span === 'stub') return `M${start} ${middle} v9`;
  if (start === end) return `M${start} ${middle} V${ROW_HEIGHT}`;
  return `M${start} ${middle} C${start} ${middle + 12} ${end} ${middle + 8} ${end} ${middle + 20} V${ROW_HEIGHT}`;
}

function GraphMark({ lane, pull, merge }: { lane: number; pull: boolean; merge: boolean }) {
  const x = coordinate(lane);
  if (pull) return <rect className="timeline-graph-mark" x={x - 3.5} y={middle - 3.5} width="7" height="7" rx="1.5" />;
  if (merge) return <g><circle className="timeline-graph-mark" cx={x} cy={middle} r="5" />
    <circle className="timeline-graph-center" cx={x} cy={middle} r="1.5" /></g>;
  return <circle className="timeline-graph-mark" cx={x} cy={middle} r="3" />;
}

function Graph({ layout, node, width }: { layout: LaneRow; node: HistoryNode; width: number }) {
  return <svg aria-hidden="true" className="timeline-graph" width={width} height={ROW_HEIGHT}
    viewBox={`0 0 ${width} ${ROW_HEIGHT}`}>
    {layout.segments.map(segment =>
      <path key={`${segment.span}/${segment.from}/${segment.to}/${segment.pull}`} d={route(segment)}
        data-lane={segment.to} data-dashed={segment.pull || segment.to === OVERFLOW_LANE || segment.span === 'stub'} />)}
    {layout.collapsed > 0 && <g>
      <title>{layout.collapsed} additional {layout.collapsed === 1 ? 'line' : 'lines'} of history sharing a lane</title>
      <text x={coordinate(OVERFLOW_LANE) + 6} y={middle + 3}>+{Math.min(layout.collapsed, 999)}{layout.collapsed > 999 && '…'}</text>
    </g>}
    <GraphMark lane={layout.lane} pull={node.kind === 'pr'} merge={node.parents.length > 1} />
  </svg>;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function parentReferences(node: HistoryNode) {
  if (node.kind === 'pr') return node.head ? 'Head commit ' + node.head.slice(0, 8) : '';
  const parents = node.parents.map(parent => parent.slice(0, 8)).join(', ');
  return parents ? (node.parents.length === 1 ? 'Parent commit ' : 'Parent commits ') + parents : '';
}

function relationship(node: HistoryNode) {
  if (node.kind === 'commit') return node.parents.length > 1 ? `Merge · ${node.parents.length} parents` : '';
  const state = node.state && node.state.charAt(0).toUpperCase() + node.state.slice(1);
  const branches = [node.headBranch, node.baseBranch].filter(Boolean).join(' → ');
  return [state, branches].filter(Boolean).join(' · ');
}

interface RowProps {
  node: HistoryNode;
  layout?: LaneRow;
  width: number;
  index: number;
  size: number;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
}

export function TimelineRow({ node, layout, width, index, size, selected, active, onSelect }: RowProps) {
  const ref = node.kind === 'pr' ? `PR #${node.ref}` : node.ref.slice(0, 8);
  const repoContext = [relationship(node), node.kind === 'commit' && node.branches.join(', '), node.author]
    .filter(Boolean).join(' · ');
  const date = Date.parse(node.date);
  const id = `change-timeline-row-${index}`;
  const parents = parentReferences(node);
  const hasDate = Number.isFinite(date);
  const description = [repoContext && id + '-context', hasDate && id + '-date', parents && id + '-parents']
    .filter(Boolean).join(' ');
  return <div id={id} role="option" aria-selected={selected} aria-labelledby={`${id}-title ${id}-ref`}
    aria-describedby={description || undefined}
    aria-posinset={index + 1} aria-setsize={size} data-active={active}
    className="timeline-option" style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
    data-change-kind={node.kind} data-change-ref={node.ref} onClick={onSelect}>
    {layout && <Graph layout={layout} node={node} width={width} />}
    <div className="timeline-label">
      <strong id={id + '-title'} title={node.title}>{node.title}</strong>
      <span className="timeline-context" title={repoContext}>
        <span className="mono" id={id + '-ref'}>{node.kind === 'commit' && <span className="sr-only">Commit </span>}{ref}</span>
        <span id={id + '-context'}>{repoContext && <><span aria-hidden="true"> · </span>{repoContext}</>}</span>
      </span>
    </div>
    {hasDate && <time id={id + '-date'} className="timeline-date" dateTime={node.date}>{dateFormat.format(date)}</time>}
    {parents && <span id={id + '-parents'} className="sr-only">{parents}</span>}
  </div>;
}
