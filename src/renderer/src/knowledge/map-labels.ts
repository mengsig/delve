import { contains, overlaps, type Position } from './map-geometry';
import type { Bounds } from './map-layout';

const labelHeight = 24;
const cellSize = 80;
export const labelThreshold = .55;
export const labelFont = '600 13px system-ui, sans-serif';

export interface HitRegion extends Position { id: number; radius: number; label?: Bounds }
export interface LabelNode extends HitRegion { title: string }
export interface MapLabel { text: string; bounds: Bounds }

function occupiedCells(bounds: Bounds, visit: (key: number) => boolean) {
  if (bounds.left > bounds.right || bounds.top > bounds.bottom) throw new Error('Invalid map collision bounds.');
  if (!Object.values(bounds).every(Number.isFinite)) throw new Error('Non-finite map collision bounds.');
  for (let y = Math.floor(bounds.top / cellSize); y <= Math.floor(bounds.bottom / cellSize); y += 1) {
    for (let x = Math.floor(bounds.left / cellSize); x <= Math.floor(bounds.right / cellSize); x += 1) {
      if (visit(y * 65536 + x)) return true;
    }
  }
  return false;
}

function labelBounds({ x, y, radius }: LabelNode, width: number): Bounds[] {
  const gap = radius + 10;
  return [
    { left: x - width / 2, right: x + width / 2, top: y + gap, bottom: y + gap + labelHeight },
    { left: x - width / 2, right: x + width / 2, top: y - gap - labelHeight, bottom: y - gap },
    { left: x + gap, right: x + gap + width, top: y - labelHeight / 2, bottom: y + labelHeight / 2 },
    { left: x - gap - width, right: x - gap, top: y - labelHeight / 2, bottom: y + labelHeight / 2 },
  ];
}

export function placeLabels(nodes: readonly LabelNode[], screen: Bounds,
  measure: (title: string) => { text: string; width: number },
  bodies: readonly HitRegion[] = nodes, obstruction?: Bounds): Map<number, MapLabel> {
  const labels = new Map<number, MapLabel>();
  if (!nodes.length) return labels;
  const bins = new Map<number, Bounds[]>();
  const insert = (bounds: Bounds) => occupiedCells(bounds, key => {
    const bucket = bins.get(key) ?? [];
    bucket.push(bounds);
    bins.set(key, bucket);
    return false;
  });
  if (obstruction) insert(obstruction);
  for (const { x, y, radius } of bodies) {
    const margin = radius + 4;
    insert({ left: x - margin, top: y - margin, right: x + margin, bottom: y + margin });
  }
  for (const node of nodes) {
    const { text, width } = measure(node.title);
    const candidates = labelBounds(node, width);
    const bounds = candidates.find(candidate => contains(screen, candidate.left, candidate.top) &&
      contains(screen, candidate.right, candidate.bottom) && !occupiedCells(candidate, key =>
        bins.get(key)?.some(entry => overlaps(entry, candidate)) ?? false));
    if (!bounds) continue;
    labels.set(node.id, { text, bounds });
    insert({ left: bounds.left - 3, right: bounds.right + 3, top: bounds.top - 3, bottom: bounds.bottom + 3 });
  }
  return labels;
}

export function pickNode(regions: readonly HitRegion[], x: number, y: number): number | null {
  let nearest = Infinity;
  let id: number | null = null;
  for (const region of regions) {
    if (region.label && contains(region.label, x, y)) return region.id;
    const distance = (region.x - x) ** 2 + (region.y - y) ** 2;
    if (distance > (region.radius + 5) ** 2 || distance >= nearest) continue;
    nearest = distance;
    id = region.id;
  }
  return id;
}
