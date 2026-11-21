import { z } from 'zod';
import type { Assessment } from './assessment';

const pack = z.literal('lease-handoff@1');

export const leaseConfigSchema = z.strictObject({
  pack,
  parameters: z.strictObject({
    taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,16}$/),
    initialGeneration: z.number().int().min(0).max(9998),
    deadlineTicks: z.number().int().min(1).max(12),
  }),
});

export const leaseStateSchema = z.strictObject({
  pack,
  tick: z.number().int().min(0).max(12),
  decision: z.enum(['accept', 'reject']).nullable(),
});

export const leaseInputSchema = z.strictObject({
  type: z.enum(['advance', 'accept', 'reject', 'reset']),
});

type LeaseConfig = z.infer<typeof leaseConfigSchema>;
type LeaseState = z.infer<typeof leaseStateSchema>;

export const leaseDefaults = leaseConfigSchema.parse({
  pack: 'lease-handoff@1',
  parameters: { taskId: '042', initialGeneration: 7, deadlineTicks: 3 },
});

export function initialLease(config: LeaseConfig): LeaseState {
  return { pack: config.pack, tick: 0, decision: null };
}

function assessWrite(generation: number, decision: NonNullable<LeaseState['decision']>): Assessment {
  const observation = `Generation ${generation} arrived while generation ${generation + 1} was active.`;
  if (decision === 'accept') return {
    demonstrated: false,
    observation,
    action: 'Practice write fencing.',
    reason: 'Accepting the stale result overwrote the active worker’s slot.',
    targetKey: 'fence',
  };
  return {
    demonstrated: true,
    observation,
    action: 'Apply the same ownership rule across a daemon restart.',
    reason: 'Rejecting the stale result left the active worker free to publish.',
    targetKey: 'recovery',
  };
}

export function transitionLease(config: LeaseConfig, state: LeaseState, input: unknown) {
  const { type } = leaseInputSchema.parse(input);
  const { deadlineTicks, initialGeneration } = config.parameters;
  if (state.tick > deadlineTicks || (state.decision !== null && state.tick !== deadlineTicks)) {
    throw new Error('Lease state does not match the configured deadline');
  }
  if (type === 'reset') return { state: initialLease(config) };
  if (type === 'advance') {
    if (state.tick === deadlineTicks) throw new Error('The lease has already expired');
    return { state: { ...state, tick: state.tick + 1 } };
  }
  if (state.tick !== deadlineTicks || state.decision !== null) {
    throw new Error('There is no pending stale write to decide');
  }
  return { state: { ...state, decision: type }, assessment: assessWrite(initialGeneration, type) };
}
