import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { Size, Viewport } from './map-camera';
import { revealPoint, zoomAt } from './map-camera';
import { directionalPoint, type Position } from './map-geometry';
import { pickNode, type HitRegion } from './map-labels';
import type { Point } from './map-layout';

interface MapInput {
  canvas: RefObject<HTMLCanvasElement | null>;
  hits: RefObject<HitRegion[]>;
  current: RefObject<Viewport>;
  move: (view: Viewport, animate?: boolean) => void;
  size: Size;
  points: Point[];
  selected: number | null;
  onSelect: (id: number) => void;
  fit: () => void;
}
interface Drag { pointerId: number; clientX: number; clientY: number; origin: Viewport; moved: boolean }

function canvasPosition(element: HTMLCanvasElement, clientX: number, clientY: number): Position {
  const bounds = element.getBoundingClientRect();
  return { x: clientX - bounds.left, y: clientY - bounds.top };
}

function useWheelZoom({ canvas, current, move }: MapInput) {
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      const { x, y } = canvasPosition(element, event.clientX, event.clientY);
      move(zoomAt(current.current, event.deltaY < 0 ? 1.13 : 1 / 1.13, x, y));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [canvas, current, move]);
}

function usePointerInput({ hits, current, move, onSelect }: MapInput, hover: (id: number | null) => void) {
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  function pick(event: PointerEvent<HTMLCanvasElement>) {
    const { x, y } = canvasPosition(event.currentTarget, event.clientX, event.clientY);
    return pickNode(hits.current, x, y);
  }

  function onPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      origin: current.current, moved: false };
  }

  function onPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const start = drag.current;
    if (!start) {
      hover(pick(event));
      return;
    }
    if (start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.clientX;
    const dy = event.clientY - start.clientY;
    if (!start.moved && Math.hypot(dx, dy) < 4) return;
    if (!start.moved) {
      start.moved = true;
      setDragging(true);
      hover(null);
    }
    move({ ...start.origin, x: start.origin.x + dx, y: start.origin.y + dy });
  }

  function endDrag(event: PointerEvent<HTMLCanvasElement>) {
    const start = drag.current;
    if (start?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.type !== 'pointerup' || start.moved) return;
    const id = pick(event);
    if (id !== null) onSelect(id);
  }

  return { dragging, handlers: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag,
    onLostPointerCapture: endDrag, onPointerLeave: () => hover(null) } };
}

const directions = new Map<string, readonly [number, number]>([
  ['ArrowLeft', [-1, 0]], ['ArrowRight', [1, 0]], ['ArrowUp', [0, -1]], ['ArrowDown', [0, 1]],
] as const);

function navigate(input: MapInput, preview: number | null, dx: number, dy: number, pan: boolean) {
  const { current, move, size, selected, points } = input;
  const view = current.current;
  if (pan) {
    move({ ...view, x: view.x - dx * 56, y: view.y - dy * 56 });
    return preview;
  }
  const from = points.find(point => point.id === (preview ?? selected));
  const next = (from && directionalPoint(points, from, dx, dy)) ?? from ?? points[0];
  if (!next) return null;
  const target = revealPoint(view, next, size);
  if (target !== view) move(target, true);
  return next.id;
}

export function useMapInput(input: MapInput) {
  const [preview, setPreview] = useState<{ id: number; keyboard: boolean } | null>(null);
  const { size, current, move, fit, onSelect, selected } = input;
  const hover = (id: number | null) => setPreview(old =>
    id === null ? null : old?.id === id && !old.keyboard ? old : { id, keyboard: false });
  const pointer = usePointerInput(input, hover);
  useWheelZoom(input);

  function zoom(factor: number) {
    move(zoomAt(current.current, factor, size.width / 2, size.height / 2), true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    if (!size.width || !size.height || event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key;
    if (key === 'Escape') {
      if (preview) event.preventDefault();
      setPreview(null);
      return;
    }
    const direction = directions.get(key);
    if (direction) {
      const [dx, dy] = direction;
      const id = navigate(input, preview?.id ?? null, dx, dy, event.shiftKey);
      if (!event.shiftKey && id !== null) setPreview({ id, keyboard: true });
    } else if (key === 'Enter' || key === ' ') {
      const id = preview?.id ?? selected;
      if (id !== null && input.points.some(point => point.id === id)) onSelect(id);
    } else if (key === '+' || key === '=') zoom(1.2);
    else if (key === '-') zoom(1 / 1.2);
    else if (key === 'Home') fit();
    else return;
    event.preventDefault();
  }

  function onFocus(event: FocusEvent<HTMLCanvasElement>) {
    const id = selected ?? input.points[0]?.id;
    if (id != null && event.currentTarget.matches(':focus-visible')) setPreview({ id, keyboard: true });
  }

  return { ...pointer, zoom, preview, onKeyDown, onFocus, onBlur: () => setPreview(null) };
}
