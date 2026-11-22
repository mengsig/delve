import { useEffect, useId, useMemo, useRef, type RefObject } from 'react';
import type { GlobalKnowledgeGraph } from '../../../shared/knowledge';
import { fitViewport, revealPoint, useMapCamera, type Size, type Viewport } from './map-camera';
import { drawGraph, prepareDrawData } from './map-drawing';
import { stateName, type NodeState } from './map-geometry';
import { labelThreshold, type HitRegion } from './map-labels';
import type { MapLayout, Point } from './map-layout';
import { useMapInput } from './use-map-input';
import { useCanvasSize, useMapLayout } from './use-map-layout';
import './map.css';

interface Props {
  graph: GlobalKnowledgeGraph;
  selected: number | null;
  visible: Set<number>;
  focus: Set<number> | null;
  onSelect: (id: number) => void;
  cameras: Map<string, Viewport>;
  states: ReadonlyMap<number, NodeState>;
  areaKey: string;
}
interface Framing { selected: number | null; visible: Set<number>; focus: Set<number> | null }
type Camera = ReturnType<typeof useMapCamera>;
type DrawingOptions = Parameters<typeof drawGraph>[3];
const emptyLayout: MapLayout = { points: [], areas: [] };

function sameMembers(a: Set<number> | null, b: Set<number> | null) {
  return a === b || !!(a && b && a.size === b.size && Array.from(a).every(id => b.has(id)));
}

function framePoints(points: Point[], focus: Set<number> | null) {
  const neighborhood = focus ? points.filter(point => focus.has(point.id)) : points;
  return neighborhood.length ? neighborhood : points;
}

function useAutomaticFraming(camera: Camera, size: Size, points: Point[], layout: MapLayout | undefined, framing: Framing) {
  const previous = useRef<Framing | null>(null);
  const beforeFocus = useRef<Viewport | null>(null);
  const { current, move, restored } = camera;
  const { focus, selected, visible } = framing;
  useEffect(() => {
    if (!layout || !size.width || !size.height) return;
    const last = previous.current;
    previous.current = { focus, selected, visible };
    if (!points.length) return;
    if (!last) {
      if (!restored) move(fitViewport(framePoints(points, focus), size));
      return;
    }
    const filterChanged = !sameMembers(last.visible, visible);
    const focusChanged = focus && !sameMembers(last.focus, focus);
    if (focus && !last.focus) beforeFocus.current = current.current;
    if (last.focus && !focus && !filterChanged && selected === last.selected) {
      move(beforeFocus.current ?? fitViewport(points, size), true);
      beforeFocus.current = null;
      return;
    }
    if (filterChanged || focusChanged) {
      move(fitViewport(framePoints(points, focus), size), true);
      return;
    }
    const point = points.find(item => item.id === selected);
    if (point && selected !== last.selected) {
      const view = current.current;
      const target = revealPoint(view, point, size);
      if (target !== view) move(target, true);
    }
  }, [current, move, restored, size, points, layout, visible, focus, selected]);
}

function useDrawing(canvas: RefObject<HTMLCanvasElement | null>, data: ReturnType<typeof prepareDrawData>,
  size: Size, view: Camera['view'], options: DrawingOptions, hitsRef: RefObject<HitRegion[]>) {
  const paint = useRef<() => void>(() => { hitsRef.current = []; });
  const measurements = useMemo(() => new Map<string, { text: string; width: number }>(), []);
  const { visible, focus, states, selected, preview } = options;
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    paint.current = () => {
      hitsRef.current = drawGraph(element, data, view, { visible, focus, states, selected, preview }, measurements);
    };
    paint.current();
  }, [canvas, data, size, view, visible, focus, states, selected, preview, measurements, hitsRef]);
  useEffect(() => {
    const observer = new MutationObserver(() => paint.current());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
}

function MapPreview({ concept, state, keyboard, prerequisites }: {
  concept: GlobalKnowledgeGraph['concepts'][number] | undefined; state: NodeState | undefined; keyboard: boolean; prerequisites: string[];
}) {
  const text = concept && <div className="knowledge-map-tip">
    <div><strong>{concept.title}</strong><span>{stateName[state ?? 'locked']}</span></div>
    {concept.summary && <p>{concept.summary}</p>}
    {prerequisites.length > 0 && <p>Builds on {prerequisites.join(', ')}.</p>}
    {concept.bridge && <p>Shared across {concept.memberships.map(w => w.workspaceName).join(', ')}.</p>}
  </div>;
  return <>
    <div role="status" aria-live="polite" aria-atomic="true">{keyboard ? text : null}</div>
    {keyboard ? null : text}
  </>;
}

function MapCompass() {
  return <svg className="knowledge-map-compass" aria-hidden="true" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
    <path d="m19 5-4.5 9.5L5 19l4.5-9.5L19 5Z" /><path d="m9.5 9.5 5 5" />
  </svg>;
}

function AreaMap({ graph, selected, visible, focus, onSelect, cameras, states, areaKey }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const instructions = useId();
  const { concepts, edges } = graph;
  const input = useMemo(() => ({ concepts, edges }), [concepts, edges]);
  const result = useMapLayout(input);
  const layout = result?.layout;
  const size = useCanvasSize(canvas);
  const camera = useMapCamera(areaKey, cameras);
  const points = useMemo(() => layout?.points.filter(point => visible.has(point.id)) ?? [], [layout, visible]);
  const data = useMemo(() => prepareDrawData(graph, layout ?? emptyLayout), [graph, layout]);
  useAutomaticFraming(camera, size, points, layout, { selected, visible, focus });
  const hitsRef = useRef<HitRegion[]>([]);
  const fit = () => {
    if (points.length && size.width && size.height) camera.move(fitViewport(points, size), true);
  };
  const interaction = useMapInput({ canvas, hits: hitsRef, size, points, selected, onSelect, fit,
    current: camera.current, move: camera.move });
  const preview = interaction.preview && visible.has(interaction.preview.id) ? interaction.preview.id : null;
  useDrawing(canvas, data, size, camera.view, { visible, focus, states, selected, preview }, hitsRef);

  const titles = useMemo(() => new Map(concepts.map(c => [c.id, c])), [concepts]);
  const concept = preview === null ? undefined : titles.get(preview);
  const prerequisites = useMemo(() => preview === null ? [] : edges.filter(e => e.conceptId === preview)
    .flatMap(e => titles.get(e.prerequisiteId)?.title ?? []), [preview, edges, titles]);
  return <div className="knowledge-map">
    {result?.error && <p className="knowledge-map-error" role="alert">{result.error}</p>}
    <p id={instructions} className="knowledge-map-instructions">
      Arrow keys explore concepts. Enter selects. Shift and arrow keys pan. Plus and minus zoom. Home fits the map.
    </p>
    <canvas ref={canvas} tabIndex={0} aria-label="Knowledge map concepts" aria-describedby={instructions}
      data-dragging={interaction.dragging || undefined} data-hover={preview !== null || undefined}
      {...interaction.handlers} onKeyDown={interaction.onKeyDown} onFocus={interaction.onFocus} onBlur={interaction.onBlur} />
    <MapCompass />
    <MapPreview concept={concept} prerequisites={prerequisites} state={preview === null ? undefined : states.get(preview)}
      keyboard={interaction.preview?.keyboard ?? false} />
    {points.length > 12 && camera.view.scale < labelThreshold && <span className="knowledge-map-zoom-hint">Zoom in to see concept names</span>}
    <div className="knowledge-map-tools" role="group" aria-label="Map controls">
      <button type="button" onClick={() => interaction.zoom(1 / 1.2)} aria-label="Zoom out">−</button>
      <button type="button" onClick={() => interaction.zoom(1.2)} aria-label="Zoom in">+</button>
      <button type="button" onClick={fit} disabled={!points.length}>Fit map</button>
    </div>
  </div>;
}

export function KnowledgeMap(props: Props) {
  return <AreaMap key={props.areaKey} {...props} />;
}
