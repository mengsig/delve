import type { GlobalKnowledgeGraph, KnowledgeConcept } from '../../../shared/knowledge';
import { workspaceColor } from './colors';
import type { Size, Viewport } from './map-camera';
import { type Curve, type NodeState, makeCurve, overlaps, project } from './map-geometry';
import { labelFont, labelThreshold, placeLabels, type HitRegion, type LabelNode, type MapLabel } from './map-labels';
import type { Area, Bounds, MapLayout, Point } from './map-layout';

interface DrawNode { concept: KnowledgeConcept; point: Point }
interface DrawData { nodes: DrawNode[]; edges: Curve[]; areas: Area[] }
interface DrawOptions {
  visible: Set<number>;
  focus: Set<number> | null;
  states: ReadonlyMap<number, NodeState>;
  selected: number | null;
  preview: number | null;
}
type Skin = [face: string, border: string, icon: string];
interface Palette {
  nodes: Record<NodeState, Skin>;
  label: string; ink: string; active: Skin; activeLabel: string; activeInk: string;
  path: string; future: string; transfer: string; area: string;
}
const light: Palette = {
  nodes: {
    mastered: ['#315a3f', '#70976a', '#f3f9e6'], 'in-progress': ['#deedbd', '#62854d', '#385a35'],
    ready: ['#fcfdf0', '#9eb28f', '#597252'], locked: ['#e1e7d9', '#a9baa1', '#647862'],
  },
  label: '#f7f9eb', ink: '#1d4634', active: ['#edf5d5', '#28573d', '#28573d'],
  activeLabel: '#28573d', activeInk: '#fffef4',
  path: '#527750', future: '#73876d', transfer: '#886022', area: '#72936c',
};
const dark: Palette = {
  nodes: {
    mastered: ['#bfdc91', '#9cb67b', '#284930'], 'in-progress': ['#385a3d', '#b3d081', '#e3f4b8'],
    ready: ['#315744', '#91aa82', '#dfedc4'], locked: ['#264338', '#69816c', '#b7c9b0'],
  },
  label: '#234636', ink: '#f1f5df', active: ['#def59e', '#cbe895', '#264d32'],
  activeLabel: '#dcf2ad', activeInk: '#264d32',
  path: '#b6ce91', future: '#99ae94', transfer: '#e4b875', area: '#a2c18b',
};

export function prepareDrawData(graph: GlobalKnowledgeGraph, { points, areas }: MapLayout): DrawData {
  const byId = new Map(points.map(point => [point.id, point]));
  if (byId.size !== points.length) throw new Error('Map drawing received duplicate points.');
  const nodes: DrawNode[] = [];
  const edges: Curve[] = [];
  for (const concept of graph.concepts) {
    const point = byId.get(concept.id);
    if (point) nodes.push({ concept, point });
  }
  const addEdge = (fromId: number, toId: number, transfer: boolean) => {
    const from = byId.get(fromId);
    const to = byId.get(toId);
    if (from && to && from.id !== to.id) edges.push(makeCurve(from, to, transfer));
  };
  graph.edges.forEach(edge => addEdge(edge.prerequisiteId, edge.conceptId, false));
  graph.links.forEach(link => addEdge(link.fromConceptId, link.toConceptId, true));
  return { nodes, edges, areas };
}

function drawAreas(ctx: CanvasRenderingContext2D, areas: Area[], bounds: Bounds, view: Viewport, palette: Palette) {
  for (const area of areas) {
    if (!overlaps(area, bounds)) continue;
    const origin = project({ x: area.left, y: area.top }, view);
    const width = (area.right - area.left) * view.scale;
    const height = (area.bottom - area.top) * view.scale;
    ctx.fillStyle = palette.area;
    ctx.strokeStyle = workspaceColor(area.id);
    ctx.lineWidth = 1;
    ctx.globalAlpha = .11;
    ctx.beginPath();
    ctx.roundRect(origin.x, origin.y, width, height, Math.min(16, width / 3, height / 3));
    ctx.fill();
    ctx.globalAlpha = .42;
    ctx.stroke();
    const titleX = Math.max(origin.x + 12, 8);
    const labelWidth = origin.x + width - titleX - 8;
    if (height >= 65 && labelWidth >= 50) {
      ctx.globalAlpha = 1;
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = palette.ink;
      ctx.fillText(area.title, titleX, origin.y + 19, labelWidth);
    }
  }
  ctx.globalAlpha = 1;
}

function drawEdges(ctx: CanvasRenderingContext2D, edges: Curve[], bounds: Bounds,
  view: Viewport, { visible, focus, states, selected }: DrawOptions, palette: Palette) {
  const groups: Curve[][] = Array.from({ length: 6 }, () => []);
  for (const edge of edges) {
    const { from, to, transfer } = edge;
    if (!visible.has(from.id) || !visible.has(to.id) || !overlaps(edge.bounds, bounds)) continue;
    const faded = focus && (!focus.has(from.id) || !focus.has(to.id));
    const active = from.id === selected || to.id === selected;
    const known = states.get(from.id) === 'mastered';
    const style = faded ? (transfer ? 1 : 0) : transfer ? 5 : known ? (active ? 4 : 3) : 2;
    groups[style]!.push(edge);
  }
  const styles: [string, number, number, number[]][] = [
    [palette.future, .17, 1, [6, 7]], [palette.transfer, .26, 1, [2, 5]],
    [palette.future, .70, 2, [6, 7]], [palette.path, .79, 2.2, []],
    [palette.path, 1, 3, []], [palette.transfer, .94, 2.2, [2, 5]],
  ];
  for (const [index, group] of groups.entries()) {
    if (!group.length) continue;
    const [color, alpha, width, dash] = styles[index]!;
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(.85, width * Math.min(1, view.scale * 1.7)) / view.scale;
    ctx.setLineDash(dash.map(value => value / view.scale));
    ctx.beginPath();
    for (const { from, to, first, second } of group) {
      ctx.moveTo(from.x, from.y);
      ctx.bezierCurveTo(first.x, first.y, second.x, second.y, to.x, to.y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
}

function drawSymbol(ctx: CanvasRenderingContext2D, node: HitRegion, state: NodeState, active: boolean, ink: string) {
  const { x, y } = node;
  if (node.radius < 8) return;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (state === 'mastered') {
    ctx.moveTo(x - 5, y); ctx.lineTo(x - 1.3, y + 3.5); ctx.lineTo(x + 5.5, y - 4);
  } else if (state === 'locked') {
    ctx.roundRect(x - 4.4, y - 1, 8.8, 7, 1.3);
    ctx.moveTo(x - 2.7, y - 1); ctx.lineTo(x - 2.7, y - 3.7);
    ctx.arc(x, y - 3.7, 2.7, Math.PI, 0);
    ctx.lineTo(x + 2.7, y - 1);
    ctx.moveTo(x, y + 1.5); ctx.lineTo(x, y + 3.5);
  } else if (active) {
    ctx.moveTo(x + 5, y - 5); ctx.lineTo(x + 2, y + 2); ctx.lineTo(x - 5, y + 5);
    ctx.lineTo(x - 2, y - 2); ctx.closePath();
  } else {
    circle(ctx, x, y, 4);
    ctx.stroke();
    circle(ctx, x, y, 1.5);
    ctx.fill();
    return;
  }
  ctx.stroke();
}

function drawNode(ctx: CanvasRenderingContext2D, node: LabelNode, concept: KnowledgeConcept, state: NodeState,
  selected: boolean, preview: boolean, palette: Palette) {
  const { x, y, radius } = node;
  const [face, border, ink] = selected && state === 'ready' ? palette.active : palette.nodes[state];
  const alpha = ctx.globalAlpha;
  if ((selected || state === 'mastered') && radius >= 7) {
    ctx.fillStyle = border;
    for (const [size, opacity] of [[1.94, .11], [1.55, .16]] as const) {
      ctx.globalAlpha = alpha * opacity;
      circle(ctx, x, y, radius * size);
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
  }
  if (selected || preview) {
    ctx.lineWidth = selected ? 1.7 : 1.25;
    ctx.strokeStyle = palette.active[1];
    circle(ctx, x, y, radius + 4);
    ctx.stroke();
  }
  if (concept.bridge && radius >= 7 && concept.memberships.length > 1) {
    const angle = Math.PI * 2 / concept.memberships.length;
    ctx.lineWidth = 1.4;
    concept.memberships.forEach(({ workspaceId }, index) => {
      ctx.strokeStyle = workspaceColor(workspaceId);
      ctx.beginPath();
      ctx.arc(x, y, radius + 2, index * angle + .14, (index + 1) * angle - .14);
      ctx.stroke();
    });
  }
  ctx.fillStyle = face;
  ctx.strokeStyle = border;
  ctx.lineWidth = radius < 6 ? .85 : 1.65;
  circle(ctx, x, y, radius);
  ctx.fill();
  ctx.stroke();
  if (state === 'in-progress') {
    ctx.beginPath();
    ctx.arc(x, y, radius + 2, -Math.PI / 2, Math.PI * .55);
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  drawSymbol(ctx, node, state, selected, ink);
}

function drawLabel(ctx: CanvasRenderingContext2D, { text, bounds }: MapLabel,
  state: NodeState, selected: boolean, palette: Palette) {
  ctx.fillStyle = selected ? palette.activeLabel : palette.label;
  ctx.strokeStyle = selected ? palette.active[1] : palette.nodes[state][1];
  ctx.lineWidth = .85;
  ctx.beginPath();
  ctx.roundRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = selected ? palette.activeInk : palette.ink;
  ctx.textAlign = 'center';
  ctx.fillText(text, (bounds.left + bounds.right) / 2, bounds.top + 16);
  ctx.textAlign = 'start';
}

function measureLabel(ctx: CanvasRenderingContext2D, title: string) {
  const limit = 154;
  let text = title;
  let width = ctx.measureText(text).width;
  if (width > limit) {
    const characters = Array.from(title);
    let lower = 0;
    let upper = characters.length;
    while (upper - lower > 1) {
      const middle = Math.floor((lower + upper) / 2);
      if (ctx.measureText(characters.slice(0, middle).join('') + '…').width <= limit) lower = middle;
      else upper = middle;
    }
    text = characters.slice(0, lower).join('') + '…';
    width = ctx.measureText(text).width;
  }
  return { text, width: Math.ceil(width) + 20 };
}

function drawNodes(ctx: CanvasRenderingContext2D, data: DrawData, size: Size, view: Viewport,
  options: DrawOptions, palette: Palette, measurements: Map<string, { text: string; width: number }>): HitRegion[] {
  const { visible, states, selected, preview, focus } = options;
  const screen = { top: 4, left: 4, right: size.width - 4, bottom: size.height - 4 };
  const margin = view.scale >= labelThreshold ? 110 : 30;
  const nodes = data.nodes.flatMap(({ concept, point }) => {
    if (!visible.has(point.id)) return [];
    const { x, y } = project(point, view);
    if (x < -margin || x > size.width + margin || y < -margin || y > size.height + margin) return [];
    const active = point.id === selected;
    const radius = (active ? 18 : 14.5) * Math.min(1, Math.max(.24, view.scale * 1.36));
    const state = states.get(point.id) ?? 'locked';
    const node: LabelNode = { id: point.id, x, y, radius, title: concept.title };
    return [{ node, concept, active, state }];
  });
  const canLabel = view.scale >= labelThreshold;
  ctx.font = labelFont;
  const labels = placeLabels(nodes
    .filter(({ node, active }) => active || node.id === preview || canLabel && (!focus || focus.has(node.id)))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.node.id - b.node.id)
    .map(({ node }) => node), screen, title => {
    const cached = measurements.get(title) ?? measureLabel(ctx, title);
    measurements.set(title, cached);
    return cached;
  }, nodes.map(({ node }) => node), { left: size.width - 160, right: size.width, top: size.height - 55, bottom: size.height });
  const hits: HitRegion[] = [];
  for (const { node, concept, active, state } of nodes) {
    const { x, y, radius } = node;
    const label = labels.get(node.id);
    const hover = node.id === preview;
    ctx.globalAlpha = focus && !focus.has(node.id) && !hover && !active ? .27 : 1;
    if (x >= -radius - 20 && x <= size.width + radius + 20 && y >= -radius - 20 && y <= size.height + radius + 20) {
      drawNode(ctx, node, concept, state, active, hover, palette);
      hits.push({ id: node.id, x, y, radius, label: label?.bounds });
    } else if (label) hits.push({ id: node.id, x, y, radius, label: label.bounds });
    if (label) drawLabel(ctx, label, state, active, palette);
  }
  ctx.globalAlpha = 1;
  return hits;
}

export function drawGraph(canvas: HTMLCanvasElement, data: DrawData, view: Viewport,
  options: DrawOptions, measurements: Map<string, { text: string; width: number }>): HitRegion[] {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return [];
  const ratio = window.devicePixelRatio || 1;
  if (!Number.isFinite(view.scale) || view.scale <= 0 || !Number.isFinite(view.x) || !Number.isFinite(view.y)) {
    throw new Error('Invalid knowledge graph viewport.');
  }
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('Invalid knowledge graph pixel ratio.');
  const pixelsWide = Math.floor(width * ratio);
  const pixelsHigh = Math.floor(height * ratio);
  if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
  if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire the knowledge map canvas context.');
  const skin = document.documentElement.dataset.theme === 'dark' ? dark : light;
  const tokens = getComputedStyle(canvas);
  const palette: Palette = { ...skin, nodes: { ...skin.nodes,
    mastered: [tokens.getPropertyValue('--mastery-fill').trim(), skin.nodes.mastered[1], skin.nodes.mastered[2]],
    'in-progress': [skin.nodes['in-progress'][0], tokens.getPropertyValue('--mastery-progress').trim(), skin.nodes['in-progress'][2]],
  } };
  const margin = 3 / view.scale;
  const bounds = { left: -view.x / view.scale - margin, top: -view.y / view.scale - margin,
    right: (width - view.x) / view.scale + margin, bottom: (height - view.y) / view.scale + margin };
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  drawAreas(ctx, data.areas, bounds, view, palette);
  ctx.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
  drawEdges(ctx, data.edges, bounds, view, options, palette);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return drawNodes(ctx, data, { width, height }, view, options, palette, measurements);
}
