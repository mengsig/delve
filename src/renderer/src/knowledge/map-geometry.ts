import { stateLabels } from './areas';
import type { ProgressState } from '../progress/model';
import type { Bounds, Point } from './map-layout';
import type { Viewport } from './map-camera';

export type NodeState = ProgressState;
export const stateName = stateLabels;
export interface Position { x: number; y: number }
export interface Curve {
  from: Point;
  to: Point;
  first: Position;
  second: Position;
  bounds: Bounds;
  transfer: boolean;
}

export function makeCurve(from: Point, to: Point, transfer: boolean): Curve {
  if (from.id === to.id) throw new Error('Map curves require distinct endpoints.');
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 0) throw new Error('Map curves require distinct finite positions.');
  const bend = Math.min(48, Math.max(20, length * .14));
  const first = { x: from.x + dx * .42, y: from.y };
  const second = { x: to.x - dx * .42, y: to.y };
  if (transfer || Math.abs(dx) < Math.abs(dy) * .48) {
    const sign = dx < 0 || (dx === 0 && dy < 0) ? -1 : 1;
    first.x = from.x + dx / 3 - sign * dy / length * bend;
    first.y = from.y + dy / 3 + sign * dx / length * bend;
    second.x = to.x - dx / 3 - sign * dy / length * bend;
    second.y = to.y - dy / 3 + sign * dx / length * bend;
  } else if (Math.abs(dy) < 56) {
    first.y -= bend;
    second.y -= bend;
  }
  return { from, to, first, second, transfer, bounds: {
    left: Math.min(from.x, first.x, second.x, to.x), right: Math.max(from.x, first.x, second.x, to.x),
    top: Math.min(from.y, first.y, second.y, to.y), bottom: Math.max(from.y, first.y, second.y, to.y),
  } };
}

export function overlaps(a: Bounds, b: Bounds) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

export function contains(bounds: Bounds, x: number, y: number) {
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

export function project(point: Position, view: Viewport): Position {
  return { x: point.x * view.scale + view.x, y: point.y * view.scale + view.y };
}

export function directionalPoint(points: readonly Point[], from: Point, dx: number, dy: number): Point | undefined {
  if (Math.abs(dx) + Math.abs(dy) !== 1) throw new Error('Map navigation requires a cardinal direction.');
  if (!Number.isFinite(from.x) || !Number.isFinite(from.y)) throw new Error('Map navigation requires a finite origin.');
  let best: Point | undefined;
  let score = Infinity;
  for (const point of points) {
    const x = point.x - from.x;
    const y = point.y - from.y;
    const forward = x * dx + y * dy;
    if (forward <= 0) continue;
    const sideways = x * dy - y * dx;
    const distance = Math.hypot(forward, sideways * 2);
    if (distance < score || (distance === score && point.id < (best?.id ?? Infinity))) {
      score = distance;
      best = point;
    }
  }
  return best;
}
