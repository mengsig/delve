import type { KnowledgeConcept, KnowledgeEdge } from '../../../shared/knowledge';

export interface Point { id: number; x: number; y: number }
export interface Bounds { left: number; top: number; right: number; bottom: number }
export interface Area extends Bounds { id: string; title: string }
export interface MapLayout { points: Point[]; areas: Area[] }
export interface LayoutInput { concepts: KnowledgeConcept[]; edges: KnowledgeEdge[] }
interface Group { id: string; title: string; concepts: KnowledgeConcept[] }
interface Topology {
  order: number[];
  rank: Map<number, number>;
  outgoing: Map<number, number[]>;
  incoming: Map<number, number>;
}

function readTopology(concepts: KnowledgeConcept[], edges: KnowledgeEdge[]): Topology {
  const ids = concepts.map(({ id }) => id).sort((a, b) => a - b);
  const incoming = new Map(ids.map(id => [id, 0]));
  if (incoming.size !== ids.length || ids.some(id => !Number.isSafeInteger(id))) {
    throw new Error('Map layout requires unique integer concept IDs.');
  }
  const outgoing = new Map<number, number[]>();
  for (const { prerequisiteId, conceptId } of edges) {
    const count = incoming.get(conceptId);
    if (count === undefined || !incoming.has(prerequisiteId)) continue;
    const targets = outgoing.get(prerequisiteId) ?? [];
    targets.push(conceptId);
    outgoing.set(prerequisiteId, targets);
    incoming.set(conceptId, count + 1);
  }
  for (const targets of outgoing.values()) targets.sort((a, b) => a - b);
  const rank = new Map(ids.map(id => [id, 0]));
  const remaining = new Map(incoming);
  const order = ids.filter(id => remaining.get(id) === 0);
  for (let index = 0; index < order.length; index += 1) {
    const id = order[index]!;
    for (const target of outgoing.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1));
      const count = remaining.get(target)! - 1;
      remaining.set(target, count);
      if (!count) order.push(target);
    }
  }
  if (order.length > ids.length) throw new Error('Map layout visited a concept more than once.');
  // Cyclic imports still receive deterministic positions.
  for (const id of ids) if (remaining.get(id)! > 0) order.push(id);
  return { order, rank, outgoing, incoming };
}

function groupConcepts(concepts: KnowledgeConcept[]): Group[] {
  const shared = [...(concepts[0]?.memberships ?? [])]
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
    .find(({ workspaceId }) => concepts.every(concept =>
      concept.memberships.some(membership => membership.workspaceId === workspaceId)));
  const groups = new Map<string, Group>();
  for (const concept of concepts) {
    const membership = shared ?? concept.memberships.reduce<KnowledgeConcept['memberships'][number] | undefined>(
      (primary, candidate) => !primary || candidate.workspaceId < primary.workspaceId ? candidate : primary, undefined);
    const id = membership?.workspaceId ?? '';
    const group = groups.get(id) ?? { id, title: membership?.workspaceName ?? 'Shared concepts', concepts: [] };
    group.concepts.push(concept);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function layeredPoints(ids: number[], topology: Topology): Point[] {
  const layers = new Map<number, number[]>();
  for (const id of ids) {
    const rank = topology.rank.get(id)!;
    const layer = layers.get(rank) ?? [];
    layer.push(id);
    layers.set(rank, layer);
  }
  return [...layers].flatMap(([rank, layer]) => layer.sort((a, b) =>
    topology.incoming.get(b)! - topology.incoming.get(a)! ||
    (topology.outgoing.get(b)?.length ?? 0) - (topology.outgoing.get(a)?.length ?? 0) || a - b,
  ).map((id, index) => {
    const x = rank * (280 - 32 * (rank - 1)) + (index % 2) * (rank === 0 ? 56 : 40);
    const y = layer.length === 1 ? [0, -50, -100, 56][rank]! :
      (index - (layer.length - 1) / 2) * 150 + (rank % 2 ? 30 : 0);
    return { id, x, y };
  }));
}

function placeGroup(group: Group, topology: Topology, sortOrder: Map<number, number>) {
  const ids = group.concepts.map(({ id }) => id);
  if (ids.some(id => !sortOrder.has(id))) throw new Error('Map layout is missing a concept rank.');
  ids.sort((a, b) => topology.rank.get(a)! - topology.rank.get(b)! || sortOrder.get(a)! - sortOrder.get(b)!);
  const ranks = ids.map(id => topology.rank.get(id)!);
  if (ids.length <= 12 && ranks.at(-1)! <= 3 && new Set(ranks).size > 1) return layeredPoints(ids, topology);

  const columns = Math.ceil(Math.sqrt(ids.length));
  return ids.map((id, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return { id, x: (row % 2 ? columns - 1 - column : column) * 180, y: row * 105 };
  });
}

export function pointBounds(points: readonly Point[]): Bounds {
  if (!points.length) throw new Error('Cannot bound an empty map.');
  const result = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const { x, y } of points) {
    result.left = Math.min(result.left, x);
    result.top = Math.min(result.top, y);
    result.right = Math.max(result.right, x);
    result.bottom = Math.max(result.bottom, y);
  }
  if (!Object.values(result).every(Number.isFinite)) throw new Error('Map layout produced non-finite coordinates.');
  return result;
}

export function layoutGraph({ concepts, edges }: LayoutInput): MapLayout {
  const topology = readTopology(concepts, edges);
  const groups = groupConcepts(concepts);
  const sortOrder = new Map(topology.order.map((id, index) => [id, index]));
  const points: Point[] = [];
  const areas: Area[] = [];
  const workspaces = groups.map(group => {
    const members = placeGroup(group, topology, sortOrder);
    const bounds = pointBounds(members);
    return { group, members, bounds, width: bounds.right - bounds.left + 180, height: bounds.bottom - bounds.top + 118 };
  });
  const rowWidth = Math.sqrt(workspaces.reduce((sum, { width, height }) => sum + width * height, 0) * 1.8);
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const { group, members, bounds, width, height } of workspaces) {
    if (x && x + width > rowWidth) {
      x = 0;
      y += rowHeight + 50;
      rowHeight = 0;
    }
    if (groups.length > 1) {
      areas.push({ id: group.id, title: group.title, left: x, top: y, right: x + width, bottom: y + height });
    }
    for (const point of members) points.push({ id: point.id, x: x + 90 + point.x - bounds.left, y: y + 58 + point.y - bounds.top });
    x += width + 50;
    rowHeight = Math.max(rowHeight, height);
  }
  if (points.length !== concepts.length) throw new Error('Map layout did not place every concept.');
  return { points, areas };
}
