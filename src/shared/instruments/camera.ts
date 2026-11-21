import { z } from 'zod';
import type { Assessment } from './assessment';

const pack = z.literal('camera-exposure@1');
export const shutterValues = [30, 125, 500] as const;
export const isoValues = [100, 200, 400, 800] as const;
const shutter = z.literal(shutterValues);
const iso = z.literal(isoValues);

export const cameraConfigSchema = z.strictObject({
  pack,
  parameters: z.strictObject({ initialShutter: shutter, initialIso: iso }),
});

export const cameraStateSchema = z.strictObject({ pack, shutter, iso, captured: z.boolean(), adjusted: z.boolean() });

export const cameraInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('shutter'), value: shutter }),
  z.strictObject({ type: z.literal('iso'), value: iso }),
  z.strictObject({ type: z.literal(['capture', 'reset']) }),
]);

type CameraConfig = z.infer<typeof cameraConfigSchema>;
type CameraState = z.infer<typeof cameraStateSchema>;

export const cameraDefaults = cameraConfigSchema.parse({
  pack: 'camera-exposure@1',
  parameters: { initialShutter: 125, initialIso: 200 },
});

export function initialCamera(config: CameraConfig): CameraState {
  const { initialShutter, initialIso } = config.parameters;
  return { pack: config.pack, shutter: initialShutter, iso: initialIso, captured: false, adjusted: false };
}

export function exposureRatio(shutter: CameraState['shutter'], iso: CameraState['iso']): number {
  return (iso / 200) * (125 / shutter);
}

export function motionTrails(shutter: CameraState['shutter']): number {
  return shutter === 30 ? 7 : shutter === 125 ? 3 : 0;
}

function assessCapture({ shutter, iso, adjusted }: CameraState): Assessment {
  const observation = `Captured at 1/${shutter} s and ISO ${iso}.`;
  if (motionTrails(shutter) > 0) return {
    status: 'partial',
    observation,
    action: 'Try a faster shutter speed.',
    reason: 'The rider still has a visible motion trail.',
    targetKey: 'shutter',
  };
  if (exposureRatio(shutter, iso) < 1) return {
    status: 'partial',
    observation,
    action: 'Keep the shutter speed and raise ISO.',
    reason: 'The rider is sharp but underexposed in this scene.',
    targetKey: 'iso',
  };
  if (!adjusted) return {
    status: 'practice',
    observation,
    action: 'Change the shutter time, then recover the brightness.',
    reason: 'The supplied settings already froze the rider at the target brightness.',
  };
  return {
    status: 'demonstrated',
    observation,
    action: 'Try panning for a different look.',
    reason: 'The short exposure froze the motion and the ISO restored the displayed brightness.',
    targetKey: 'pan',
  };
}

export function transitionCamera(config: CameraConfig, state: CameraState, raw: unknown) {
  const input = cameraInputSchema.parse(raw);
  switch (input.type) {
    case 'reset': return { state: initialCamera(config) };
    case 'shutter': return { state: { ...state, shutter: input.value, captured: false, adjusted: state.adjusted || input.value !== state.shutter } };
    case 'iso': return { state: { ...state, iso: input.value, captured: false, adjusted: state.adjusted || input.value !== state.iso } };
    case 'capture': return { state: { ...state, captured: true }, assessment: assessCapture(state) };
  }
}
