import type { HistoryNode } from '../../../shared/explorer';
import type { ChangeRef } from '../../../shared/repository';

export const OVERFLOW_LANE = 4;

interface Track {
  lane: number;
  pull: boolean;
}

export interface Segment {
  from: number;
  to: number;
  span: 'through' | 'incoming' | 'outgoing' | 'stub';
  pull: boolean;
}

export interface LaneRow {
  lane: number;
  segments: Segment[];
  collapsed: number;
}

interface Edge {
  target: string;
  pull: boolean;
}

export const changeKey = ({ kind, ref }: ChangeRef) => kind + '/' + ref;
const commitKey = (ref: string) => changeKey({ kind: 'commit', ref });

class ActiveLanes {
  private readonly targets = new Map<string, Track>();
  private readonly occupied = new Map<number, boolean>();

  get collapsed() {
    return this.targets.size - this.occupied.size;
  }

  free() {
    for (let lane = 0; lane < OVERFLOW_LANE; lane++) {
      if (!this.occupied.has(lane)) return lane;
    }
    return OVERFLOW_LANE;
  }

  take(key: string) {
    const track = this.targets.get(key);
    if (!track) return undefined;
    this.targets.delete(key);
    if (track.lane < OVERFLOW_LANE && !this.occupied.delete(track.lane)) {
      throw new Error('History graph lost a reserved lane.');
    }
    return track;
  }

  reserve({ target, pull }: Edge, preferred: number) {
    const existing = this.targets.get(target);
    if (existing) return existing.lane;
    const lane = this.occupied.has(preferred) ? this.free() : preferred;
    if (lane < 0 || lane > OVERFLOW_LANE) throw new Error('History graph lane is out of bounds.');
    this.targets.set(target, { lane, pull });
    if (lane < OVERFLOW_LANE) this.occupied.set(lane, pull);
    return lane;
  }

  passing(): Segment[] {
    const segments = Array.from(this.occupied, ([lane, pull]): Segment =>
      ({ from: lane, to: lane, span: 'through', pull }));
    if (this.collapsed > 0) segments.push({ from: OVERFLOW_LANE, to: OVERFLOW_LANE, span: 'through', pull: false });
    return segments;
  }
}

function historyEdges(nodes: readonly HistoryNode[], extend: boolean) {
  const slots = new Map(nodes.map((node, index) => [changeKey(node), { node, index, edges: [] as Edge[] }]));
  if (slots.size !== nodes.length) throw new Error('History graph contains duplicate changes.');
  for (const [key, { node, index, edges }] of slots) {
    const pull = node.kind === 'pr';
    for (const parent of new Set(node.parents)) {
      const target = commitKey(parent);
      const parentSlot = slots.get(target);
      if (parentSlot?.index === index) throw new Error('A history change references itself as a parent.');
      if (parentSlot && parentSlot.index < index) parentSlot.edges.push({ target: key, pull });
      else edges.push({ target: parentSlot || extend ? target : '', pull });
    }
  }
  return slots;
}

function laneRow(active: ActiveLanes, key: string, edges: Edge[], pull: boolean): LaneRow {
  const before = active.collapsed;
  const incoming = active.take(key);
  const lane = incoming?.lane ?? active.free();
  const segments = active.passing();
  if (incoming) segments.push({ from: incoming.lane, to: lane, span: 'incoming', pull: incoming.pull });
  for (const [index, edge] of edges.entries()) {
    if (!edge.target) {
      segments.push({ from: lane, to: lane, span: 'stub', pull });
      continue;
    }
    const to = active.reserve(edge, index === 0 ? lane : active.free());
    segments.push({ from: lane, to, span: 'outgoing', pull: edge.pull });
  }
  const collapsed = Math.max(before, active.collapsed, Number(lane === OVERFLOW_LANE));
  const unique = new Map(segments.map(segment => [
    [segment.span, segment.from, segment.to, segment.pull].join('/'), segment,
  ]));
  return { lane, segments: [...unique.values()], collapsed };
}

/** Walk the display order and keep one track per pending destination. */
export function layoutLanes(nodes: readonly HistoryNode[], extend: boolean): LaneRow[] {
  const active = new ActiveLanes();
  return Array.from(historyEdges(nodes, extend), ([key, { node, edges }]) => laneRow(active, key, edges, node.kind === 'pr'));
}
