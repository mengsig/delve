import { describe, expect, it } from 'vitest';
import { defaultPack, initialState, packSchema, transition } from './index';

function lease(deadlineTicks = 3) {
  return packSchema.parse({ pack: 'lease-handoff@1', parameters: { taskId: '042', initialGeneration: 7, deadlineTicks } });
}

describe('lease handoff', () => {
  it.each(['accept', 'reject'] as const)('assesses a stale write decision to %s once per run', decision => {
    const config = lease(2);
    const initial = initialState(config);
    const first = transition(config, initial, { type: 'advance' });
    const second = transition(config, first.state, { type: 'advance' });
    const result = transition(config, second.state, { type: decision });
    expect(first.assessment).toBeUndefined();
    expect(second.state).toMatchObject({ tick: 2, decision: null });
    expect(result).toMatchObject({
      state: { tick: 2, decision },
      assessment: {
        demonstrated: decision === 'reject',
        observation: `You ${decision === 'accept' ? 'accepted' : 'rejected'} generation 7 while generation 8 was active.`,
        targetKey: decision === 'reject' ? 'recovery' : 'fence',
      },
    });
    expect(() => transition(config, result.state, { type: decision })).toThrow();
    expect(transition(config, result.state, { type: 'reset' })).toEqual({ state: initial });
  });

  it('rejects premature writes, forged payloads and ticks past the deadline', () => {
    const config = lease(1);
    const initial = initialState(config);
    expect(() => transition(config, initial, { type: 'reject' })).toThrow();
    expect(() => transition(config, initial, { type: 'advance', tick: 8 })).toThrow();
    const { state } = transition(config, initial, { type: 'advance' });
    expect(() => transition(config, state, { type: 'advance' })).toThrow();
  });

  it('supplies legacy defaults while requiring all explicit parameters', () => {
    expect(defaultPack('lease-handoff@1')).toEqual(lease());
    expect(defaultPack('constructor')).toBeNull();
    expect(packSchema.safeParse({ pack: 'lease-handoff@1' }).success).toBe(false);
    expect(packSchema.safeParse({ pack: 'lease-handoff@1', parameters: { taskId: '042', deadlineTicks: 3 } }).success)
      .toBe(false);
    expect(packSchema.safeParse({ ...lease(), extra: true }).success).toBe(false);
  });
});
