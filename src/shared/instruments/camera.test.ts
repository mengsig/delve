import { describe, expect, it } from 'vitest';
import { defaultPack, initialState, packSchema, transition } from './index';

const config = packSchema.parse({
  pack: 'camera-exposure@1', parameters: { initialShutter: 30, initialIso: 100 },
});

describe('camera exposure', () => {
  it.each([
    [30, 800, false, 'shutter'],
    [125, 800, false, 'shutter'],
    [500, 400, false, 'iso'],
    [500, 800, true, 'pan'],
  ])('assesses host settings at 1/%s and ISO %s', (shutter, iso, demonstrated, targetKey) => {
    const initial = initialState(config);
    const shutterChange = transition(config, initial, { type: 'shutter', value: shutter });
    const isoChange = transition(config, shutterChange.state, { type: 'iso', value: iso });
    const result = transition(config, isoChange.state, { type: 'capture' });
    expect(shutterChange.assessment).toBeUndefined();
    expect(isoChange.assessment).toBeUndefined();
    expect(result).toMatchObject({
      state: { shutter, iso, captured: true },
      assessment: { demonstrated, targetKey },
    });
    expect(transition(config, result.state, { type: 'reset' })).toEqual({ state: initial });
  });

  it('rejects custom capture payloads, unsupported settings and mismatched pack state', () => {
    const state = initialState(config);
    expect(() => transition(config, state, { type: 'capture', iso: 800 })).toThrow();
    expect(() => transition(config, state, { type: 'shutter', value: 499 })).toThrow();
    expect(() => transition(config, state, { type: 'iso', value: '800' })).toThrow();
    expect(() => transition(config, { pack: 'lease-handoff@1', tick: 0, decision: null }, { type: 'reset' })).toThrow();
    expect(defaultPack('camera-exposure@1')?.parameters).toEqual({ initialShutter: 125, initialIso: 200 });
  });
});
