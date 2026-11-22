import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { GlobalKnowledgeGraph, KnowledgeConcept } from '../../../shared/knowledge';
import type { Point } from './layout.worker';
import { workspaceColor } from './colors';

interface Viewport { x: number; y: number; scale: number }
interface Props { graph: GlobalKnowledgeGraph; selected: number | null; visible: Set<number>; focus: Set<number> | null; onSelect: (id: number) => void }
const defaultView = { x: 70, y: 70, scale: 0.8 };
function initialView(): Viewport {
  try {
    const saved = JSON.parse(localStorage.getItem('delve.knowledge.viewport') ?? 'null') as Viewport | null;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.scale >= 0.1 && saved.scale <= 3) return saved;
  } catch { /* Invalid saved preferences fall back to the initial view. */ }
  return defaultView;
}

export function KnowledgeMap({ graph, selected, visible, focus, onSelect }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; view: Viewport; moved: boolean } | null>(null);
  const needsFitRef = useRef(!localStorage.getItem('delve.knowledge.viewport'));
  const [view, setView] = useState(initialView);
  const { points, layoutError } = useLayoutPoints(graph.concepts);
  useFitView(canvas, points, selected, needsFitRef, setView);
  usePersistView(view);
  useWheelZoom(canvas, setView);
  const drawData = useMemo(() => prepareDrawData(graph, points), [graph, points]);
  useGraphDrawing(canvas, drawData, view, visible, focus, selected);
  function pick(event: React.PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left - view.x) / view.scale;
    const y = (event.clientY - bounds.top - view.y) / view.scale;
    const nearest = points.find(point => visible.has(point.id) && Math.hypot(point.x - x, point.y - y) < 18 / view.scale);
    if (nearest) onSelect(nearest.id);
  }
  function zoom(factor: number) {
    const element = canvas.current;
    if (element) setView(old => zoomAt(old, factor, element.clientWidth / 2, element.clientHeight / 2));
  }
  return <div className="knowledge-map">
    {layoutError && <p role="alert">{layoutError}</p>}
    <canvas ref={canvas} aria-label="Knowledge graph. Use search or the learned list to select a concept."
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, view, moved: false }; }}
      onPointerMove={event => { const start = drag.current; if (!start) return; const dx = event.clientX - start.x; const dy = event.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true; setView({ ...start.view, x: start.view.x + dx, y: start.view.y + dy }); }}
      onPointerUp={event => { if (drag.current && !drag.current.moved) pick(event); drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }} />
    <div className="knowledge-map-tools"><button onClick={() => zoom(1.2)} aria-label="Zoom in">+</button>
      <button onClick={() => zoom(1 / 1.2)} aria-label="Zoom out">−</button><button onClick={() => setView(defaultView)}>Reset view</button></div>
  </div>;
}

function useLayoutPoints(concepts: KnowledgeConcept[]) {
  const [points, setPoints] = useState<Point[]>([]);
  const [layoutError, setLayoutError] = useState('');
  useEffect(() => {
    const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<Point[]>) => setPoints(event.data);
    worker.onerror = () => setLayoutError('Could not lay out the knowledge graph. Try reopening Knowledge.');
    worker.postMessage(concepts);
    return () => worker.terminate();
  }, [concepts]);
  return { points, layoutError };
}

function useFitView(canvas: RefObject<HTMLCanvasElement | null>, points: Point[], selected: number | null,
  needsFitRef: RefObject<boolean>, setView: React.Dispatch<React.SetStateAction<Viewport>>) {
  useEffect(() => {
    const element = canvas.current;
    const point = points.find(item => item.id === selected);
    if (!element || !points.length) return;
    if (!point && needsFitRef.current) {
      needsFitRef.current = false;
      const maxX = Math.max(...points.map(item => item.x));
      const maxY = Math.max(...points.map(item => item.y));
      const scale = Math.max(.1, Math.min(1, (element.clientWidth - 100) / (maxX + 100), (element.clientHeight - 100) / (maxY + 100)));
      setView({ x: 50, y: 50, scale });
      return;
    }
    if (!point) return;
    needsFitRef.current = false;
    setView(old => ({ ...old, x: element.clientWidth / 2 - point.x * old.scale, y: element.clientHeight / 2 - point.y * old.scale }));
  }, [canvas, selected, points, needsFitRef, setView]);
}

function useWheelZoom(canvas: RefObject<HTMLCanvasElement | null>, setView: React.Dispatch<React.SetStateAction<Viewport>>) {
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const x = event.clientX - bounds.left; const y = event.clientY - bounds.top;
      setView(old => zoomAt(old, event.deltaY < 0 ? 1.12 : 1 / 1.12, x, y));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [canvas, setView]);
}

function zoomAt(view: Viewport, factor: number, x: number, y: number): Viewport {
  const scale = Math.max(.1, Math.min(3, view.scale * factor));
  const ratio = scale / view.scale;
  return { x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio, scale };
}

interface DrawNode { concept: KnowledgeConcept; point: Point; label: string; labelBounds?: Bounds }
interface DrawEdge { from: Point; to: Point; transfer: boolean }
interface DrawData { nodes: DrawNode[]; edges: DrawEdge[] }
interface Bounds { left: number; top: number; right: number; bottom: number }

export function prepareDrawData(graph: GlobalKnowledgeGraph, points: Point[]): DrawData {
  const byId = new Map(points.map(point => [point.id, point]));
  const nodes: DrawNode[] = [];
  const edges: DrawEdge[] = [];
  for (const concept of graph.concepts) {
    const point = byId.get(concept.id);
    if (point) nodes.push({ concept, point, label: concept.title.slice(0, 28) });
  }
  const addEdge = (fromId: number, toId: number, transfer: boolean) => {
    const from = byId.get(fromId); const to = byId.get(toId);
    if (from && to) edges.push({ from, to, transfer });
  };
  graph.edges.forEach(edge => addEdge(edge.prerequisiteId, edge.conceptId, false));
  graph.links.forEach(link => addEdge(link.fromConceptId, link.toConceptId, true));
  return { nodes, edges };
}

function usePersistView(view: Viewport) {
  const latest = useRef(view);
  useEffect(() => {
    latest.current = view;
    const timer = window.setTimeout(() => localStorage.setItem('delve.knowledge.viewport', JSON.stringify(view)), 250);
    return () => window.clearTimeout(timer);
  }, [view]);
  useEffect(() => () => localStorage.setItem('delve.knowledge.viewport', JSON.stringify(latest.current)), []);
}

function useGraphDrawing(canvas: RefObject<HTMLCanvasElement | null>, data: DrawData, view: Viewport,
  visible: Set<number>, focus: Set<number> | null, selected: number | null) {
  const draw = useRef<() => void>(() => {});
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    draw.current = () => drawGraph(element, data, view, visible, focus, selected);
    draw.current();
  }, [canvas, data, view, visible, focus, selected]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const redraw = () => draw.current();
    const observer = new ResizeObserver(redraw);
    observer.observe(element);
    const theme = new MutationObserver(redraw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { observer.disconnect(); theme.disconnect(); };
  }, [canvas]);
}

export function drawGraph(canvas: HTMLCanvasElement, data: DrawData, view: Viewport,
  visible: Set<number>, focus: Set<number> | null, selected: number | null) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  if (!Number.isFinite(view.scale) || view.scale <= 0 || !Number.isFinite(view.x) || !Number.isFinite(view.y)) {
    throw new Error('Invalid knowledge graph viewport');
  }
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('Invalid device pixel ratio');
  const width = Math.floor(rect.width * ratio); const height = Math.floor(rect.height * ratio);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
  ctx.lineWidth = 1;
  const bounds = { left: -view.x / view.scale, top: -view.y / view.scale,
    right: (rect.width - view.x) / view.scale, bottom: (rect.height - view.y) / view.scale };
  drawEdges(ctx, data.edges, bounds, view.scale, visible, focus);
  drawNodes(ctx, canvas, data.nodes, bounds, view.scale, visible, focus, selected);
  ctx.globalAlpha = 1;
}

function drawEdges(ctx: CanvasRenderingContext2D, edges: DrawEdge[], bounds: Bounds, scale: number,
  visible: Set<number>, focus: Set<number> | null) {
  const margin = 2 / scale;
  for (const { from, to, transfer } of edges) {
    if (!visible.has(from.id) || !visible.has(to.id)) continue;
    if (Math.max(from.x, to.x) < bounds.left - margin || Math.min(from.x, to.x) > bounds.right + margin ||
      Math.max(from.y, to.y) < bounds.top - margin || Math.min(from.y, to.y) > bounds.bottom + margin) continue;
    ctx.globalAlpha = focus && (!focus.has(from.id) || !focus.has(to.id)) ? .08 : .55;
    ctx.strokeStyle = transfer ? '#cf9d4d' : '#8aab9b'; ctx.setLineDash(transfer ? [5, 5] : []);
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawNodes(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, nodes: DrawNode[], bounds: Bounds,
  scale: number, visible: Set<number>, focus: Set<number> | null, selected: number | null) {
  const textColor = getComputedStyle(canvas).color;
  ctx.font = '12px sans-serif';
  for (const node of nodes) {
    const { concept, point } = node;
    if (!visible.has(concept.id)) continue;
    if (scale >= .55 && !node.labelBounds) {
      const metrics = ctx.measureText(node.label);
      node.labelBounds = { left: 18 - metrics.actualBoundingBoxLeft, right: 18 + metrics.actualBoundingBoxRight,
        top: 4 - metrics.actualBoundingBoxAscent, bottom: 4 + metrics.actualBoundingBoxDescent };
    }
    const label = scale >= .55 ? node.labelBounds : undefined;
    if (point.x + Math.max(17, label?.right ?? 0) < bounds.left ||
      point.x + Math.min(-17, label?.left ?? 0) > bounds.right ||
      point.y + Math.max(17, label?.bottom ?? 0) < bounds.top ||
      point.y + Math.min(-17, label?.top ?? 0) > bounds.bottom) continue;
    drawNode(ctx, node, scale, focus, selected, textColor);
  }
}

function drawNode(ctx: CanvasRenderingContext2D, node: DrawNode, scale: number, focus: Set<number> | null,
  selected: number | null, textColor: string) {
  const { concept, point } = node;
  ctx.globalAlpha = focus && !focus.has(concept.id) ? .12 : 1;
  ctx.fillStyle = concept.masteryState === 'verified' ? '#547d5e' : concept.masteryState === 'in-progress' ? '#d29d42' : concept.masteryState === 'skipped' ? '#a37d8f' : '#a2b0a7';
  ctx.beginPath(); ctx.arc(point.x, point.y, concept.id === selected ? 11 : 8, 0, Math.PI * 2); ctx.fill();
  if (concept.masteredDepth && scale >= .55) {
    ctx.fillStyle = '#fff'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText({ high: 'H', medium: 'M', low: 'D' }[concept.masteredDepth], point.x, point.y + 3);
    ctx.textAlign = 'start';
  }
  ctx.lineWidth = 3;
  concept.memberships.forEach((membership, index) => {
    ctx.strokeStyle = workspaceColor(membership.workspaceId);
    ctx.beginPath(); ctx.arc(point.x, point.y, 12, index * Math.PI * 2 / concept.memberships.length,
      (index + 1) * Math.PI * 2 / concept.memberships.length); ctx.stroke();
  });
  if (concept.bridge) { ctx.strokeStyle = '#e2b451'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(point.x, point.y, 15, 0, Math.PI * 2); ctx.stroke(); }
  if (scale >= .55) { ctx.fillStyle = textColor; ctx.font = '12px sans-serif'; ctx.fillText(node.label, point.x + 18, point.y + 4); }
}
