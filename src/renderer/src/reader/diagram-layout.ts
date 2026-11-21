import type { DiagramEdge } from '../../../shared/lesson-blocks';

interface RoutedEdge {
  edge: DiagramEdge;
  start: number;
  end: number;
  lane: number;
  returns: boolean;
}

function nodeOrder(count: number, edges: DiagramEdge[]): number[] {
  const outgoing: number[][] = Array.from({ length: count }, () => []);
  const incoming = Array<number>(count).fill(0);
  for (const { from, to } of edges) {
    const targets = outgoing[from];
    const degree = incoming[to];
    if (targets === undefined || degree === undefined) throw new Error('Diagram layout needs valid edge endpoints.');
    if (from === to) continue;
    targets.push(to);
    incoming[to] = degree + 1;
  }
  const ready: number[] = [];
  for (let node = count - 1; node >= 0; node--) {
    if (incoming[node] === 0) ready.push(node);
  }
  const order: number[] = [];
  let firstRemaining = 0;
  while (order.length < count) {
    while (incoming[firstRemaining] === -1) firstRemaining++;
    const node = ready.pop() ?? firstRemaining;
    const targets = outgoing[node];
    if (targets === undefined || incoming[node] === -1) throw new Error('Diagram layout selected an invalid node.');
    order.push(node);
    // If every remaining node has a predecessor, start a cycle at the first remaining node.
    incoming[node] = -1;
    for (const target of targets) {
      const degree = incoming[target];
      if (degree === undefined || degree === 0) throw new Error('Diagram layout lost track of an incoming edge.');
      if (degree === -1) continue;
      incoming[target] = degree - 1;
      if (degree === 1) ready.push(target);
    }
  }
  return order;
}

export function layoutDiagram(nodes: string[], explicitEdges?: DiagramEdge[]) {
  const edges = explicitEdges ?? nodes.slice(1).map((_, from): DiagramEdge => ({ from, to: from + 1 }));
  const order = nodeOrder(nodes.length, edges);
  const rows = Array<number>(nodes.length);
  order.forEach((node, row) => { rows[node] = row; });

  const direct = new Map<number, DiagramEdge>();
  const branches: Omit<RoutedEdge, 'lane'>[] = [];
  for (const edge of edges) {
    const from = rows[edge.from];
    const to = rows[edge.to];
    if (from === undefined || to === undefined) throw new Error('Diagram layout needs valid edge endpoints.');
    if (to === from + 1 && !direct.has(from)) {
      direct.set(from, edge);
      continue;
    }
    const departure = 4 * from + 3;
    const arrival = 4 * to + 2;
    branches.push({
      edge, start: Math.min(departure, arrival), end: Math.max(departure, arrival), returns: arrival < departure,
    });
  }

  const lanes: { end: number; labeled: boolean }[] = [];
  const routed: RoutedEdge[] = branches.sort((a, b) => a.start - b.start || a.end - b.end).map(branch => {
    const available = lanes.findIndex(lane => lane.end < branch.start);
    const lane = available === -1 ? lanes.length : available;
    lanes[lane] = { end: branch.end, labeled: Boolean(branch.edge.label) || Boolean(lanes[lane]?.labeled) };
    return { ...branch, lane };
  });
  return { order, edges, direct, routed, lanes };
}
