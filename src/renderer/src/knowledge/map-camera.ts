import { useCallback, useEffect, useRef, useState } from 'react';
import { motionDuration } from '../design/motion';
import { pointBounds, type Point } from './map-layout';

export interface Viewport { x: number; y: number; scale: number }
export interface Size { width: number; height: number }
const storageKey = 'delve.knowledge.viewport';
const layoutVersion = 2;
const minimumScale = .04;
const maximumScale = 3;
const initialView = { x: 0, y: 0, scale: 1 };
const areaStorageKey = (areaKey: string) => `${storageKey}.${encodeURIComponent(areaKey)}`;

export function isViewport(view: unknown): view is Viewport {
  if (!view || typeof view !== 'object' || !('x' in view && 'y' in view && 'scale' in view)) return false;
  return Number.isFinite(view.x) && Number.isFinite(view.y) && typeof view.scale === 'number' &&
    view.scale >= minimumScale && view.scale <= maximumScale;
}

export function readViewport(storage: Storage, areaKey: string): Viewport | null {
  const saved = storage.getItem(areaStorageKey(areaKey));
  if (saved === null) return null;
  try {
    const view: unknown = JSON.parse(saved);
    if (!view || typeof view !== 'object' || !('version' in view) || view.version !== layoutVersion) return null;
    return isViewport(view) ? { x: view.x, y: view.y, scale: view.scale } : null;
  } catch (cause) {
    if (cause instanceof SyntaxError) return null;
    throw cause;
  }
}

export function writeViewport(storage: Storage, areaKey: string, view: Viewport) {
  if (!isViewport(view)) throw new Error('Cannot save an invalid knowledge map camera.');
  storage.setItem(areaStorageKey(areaKey), JSON.stringify({ ...view, version: layoutVersion }));
  storage.setItem(storageKey, JSON.stringify(view));
}

export function fitViewport(points: readonly Pick<Point, 'x' | 'y'>[], { width, height }: Size): Viewport {
  if (!(width > 0 && height > 0)) throw new Error('Cannot fit the map without a visible canvas.');
  const bounds = pointBounds(points);
  const spanX = bounds.right - bounds.left;
  const spanY = bounds.bottom - bounds.top;
  const scale = Math.max(minimumScale, Math.min(1, (width - 144) / Math.max(1, spanX),
    (height - 152) / Math.max(1, spanY)));
  return {
    x: (width - spanX * scale) / 2 - bounds.left * scale,
    y: (height - spanY * scale) / 2 - bounds.top * scale - 14,
    scale,
  };
}

export function zoomAt(view: Viewport, factor: number, x: number, y: number): Viewport {
  if (!isViewport(view) || !Number.isFinite(factor) || factor <= 0) throw new Error('Invalid map zoom.');
  const scale = Math.max(minimumScale, Math.min(maximumScale, view.scale * factor));
  const ratio = scale / view.scale;
  return { x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio, scale };
}

export function revealPoint(view: Viewport, point: Point, { width, height }: Size): Viewport {
  if (!isViewport(view)) throw new Error('Cannot reveal a map point from an invalid camera.');
  if (!(width > 0 && height > 0)) throw new Error('Cannot reveal a map point without a visible canvas.');
  const x = point.x * view.scale + view.x;
  const y = point.y * view.scale + view.y;
  if (x >= 24 && x <= width - 24 && y >= 24 && y <= height - 48) return view;
  return { ...view, x: width / 2 - point.x * view.scale, y: height / 2 - point.y * view.scale };
}

export function useMapCamera(areaKey: string, cameras: Map<string, Viewport>) {
  const [restored] = useState(() => cameras.get(areaKey) ?? readViewport(localStorage, areaKey));
  const [view, setView] = useState(restored ?? initialView);
  const current = useRef(view);
  const pending = useRef<Viewport | null>(null);
  const frame = useRef(0);
  const timer = useRef(0);
  const move = useCallback((next: Viewport, animate = false) => {
    if (!isViewport(next)) throw new Error('Invalid knowledge map camera movement.');
    cancelAnimationFrame(frame.current);
    window.clearTimeout(timer.current);
    pending.current = next;
    cameras.set(areaKey, next);
    timer.current = window.setTimeout(() => {
      writeViewport(localStorage, areaKey, next);
      pending.current = null;
    }, 250);
    const from = current.current;
    const duration = animate ? motionDuration(200) : 0;
    const update = (step: Viewport) => {
      current.current = step;
      setView(step);
    };
    if (!duration) {
      update(next);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min(1, (now - start) / duration);
      const fraction = 1 - (1 - elapsed) ** 3;
      update({
        x: from.x + (next.x - from.x) * fraction,
        y: from.y + (next.y - from.y) * fraction,
        scale: from.scale + (next.scale - from.scale) * fraction,
      });
      if (elapsed < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [areaKey, cameras]);
  useEffect(() => {
    if (restored) {
      cameras.set(areaKey, restored);
      writeViewport(localStorage, areaKey, restored);
    }
    return () => {
      cancelAnimationFrame(frame.current);
      window.clearTimeout(timer.current);
      if (pending.current) {
        writeViewport(localStorage, areaKey, pending.current);
        pending.current = null;
      }
    };
  }, [areaKey, cameras, restored]);
  return { view, current, move, restored: restored !== null };
}
