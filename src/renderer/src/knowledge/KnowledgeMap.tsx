import { useEffect, useRef, useState, type RefObject } from 'react';
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
  useEffect(() => { localStorage.setItem('delve.knowledge.viewport', JSON.stringify(view)); }, [view]);
  useWheelZoom(canvas, setView);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const draw = () => drawGraph(element, graph, points, view, visible, focus, selected);
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    draw();
    return () => { observer.disconnect(); theme.disconnect(); };
  }, [graph, points, view, visible, focus, selected]);
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

function drawGraph(canvas: HTMLCanvasElement, graph: GlobalKnowledgeGraph, points: Point[], view: Viewport,
  visible: Set<number>, focus: Set<number> | null, selected: number | null) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
  const byId = new Map(points.map(point => [point.id, point]));
  const edges = [...graph.edges.map(edge => [edge.prerequisiteId, edge.conceptId, false] as const),
    ...graph.links.map(link => [link.fromConceptId, link.toConceptId, true] as const)];
  for (const [from, to, transfer] of edges) {
    const a = byId.get(from); const b = byId.get(to);
    if (!a || !b || !visible.has(from) || !visible.has(to)) continue;
    ctx.globalAlpha = focus && (!focus.has(from) || !focus.has(to)) ? .08 : .55;
    ctx.strokeStyle = transfer ? '#cf9d4d' : '#8aab9b'; ctx.setLineDash(transfer ? [5, 5] : []);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.setLineDash([]);
  const textColor = getComputedStyle(canvas).color;
  for (const concept of graph.concepts) {
    const point = byId.get(concept.id);
    if (!point || !visible.has(concept.id)) continue;
    ctx.globalAlpha = focus && !focus.has(concept.id) ? .12 : 1;
    ctx.fillStyle = concept.masteryState === 'verified' ? '#547d5e' : concept.masteryState === 'in-progress' ? '#d29d42' : concept.masteryState === 'skipped' ? '#a37d8f' : '#a2b0a7';
    ctx.beginPath(); ctx.arc(point.x, point.y, concept.id === selected ? 11 : 8, 0, Math.PI * 2); ctx.fill();
    if (concept.masteredDepth && view.scale >= .55) {
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
    if (view.scale >= .55) { ctx.fillStyle = textColor; ctx.font = '12px sans-serif'; ctx.fillText(concept.title.slice(0, 28), point.x + 18, point.y + 4); }
  }
  ctx.globalAlpha = 1;
}
