import { z } from 'zod';

const unit = z.number().min(0).max(100);
const control = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  label: z.string().trim().min(1).max(80),
});
const mark = z.strictObject({
  x: unit, y: unit, width: unit, height: unit, color: z.string().regex(/^#[0-9a-f]{6}$/i),
});

export const viewSchema = z.strictObject({
  text: z.string().min(1).max(1500),
  controls: z.array(control).max(32),
  marks: z.array(mark).max(256),
}).refine(view => new Set(view.controls.map(item => item.id)).size === view.controls.length,
  'Each instrument control needs a distinct ID.');

export type InstrumentView = z.infer<typeof viewSchema>;
export const MAX_VIEW_BYTES = 32768;
