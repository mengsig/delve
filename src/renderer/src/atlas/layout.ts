import { keySegment, type DemoPlate } from './demoAtlas';
import type { AtlasModel } from './model';

type Point = { x: number; y: number };
const PLATE_POSITIONS = [[12, 30], [17, 79], [45, 46], [69, 20], [61, 81], [88, 54]] as const;

export function positions(model: AtlasModel, width: number, height: number, demo?: DemoPlate): Map<number, Point> {
  if (!(width > 0 && height > 0)) throw new Error('Atlas layout needs a positive viewport size.');
  const points = new Map<number, Point>();
  const layers = model.layers.length;
  const margin = Math.min(96, width * 0.12);
  const span = width - 2 * margin;
  const spacing = Math.max(150, span / Math.max(1, layers - 1));
  for (const [column, layer] of model.layers.entries()) {
    for (const [row, concept] of layer.entries()) {
      const index = demo?.order.findIndex(key => key === keySegment(concept.key));
      const position = index === undefined ? undefined : PLATE_POSITIONS[index];
      if (position) {
        points.set(concept.id, { x: width * (.08 + .84 * position[0] / 100), y: height * position[1] / 100 });
      } else {
        const gap = Math.max(70, (height - 82) / Math.max(1, layer.length - 1));
        const x = layers === 1 ? width / 2 : margin + column * spacing;
        const y = layer.length === 1 ? height / 2 : 33 + row * gap;
        points.set(concept.id, { x, y });
      }
    }
  }
  if (points.size !== model.byId.size) throw new Error('Atlas layout omitted a concept.');
  return points;
}
