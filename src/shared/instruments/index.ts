import { z } from 'zod';
import type { Assessment } from './assessment';
import {
  cameraConfigSchema, cameraDefaults, cameraInputSchema, cameraStateSchema, initialCamera, transitionCamera,
} from './camera';
import {
  initialLease, leaseConfigSchema, leaseDefaults, leaseInputSchema, leaseStateSchema, transitionLease,
} from './lease';
import {
  initialNetwork, networkConfigSchema, networkDefaults, networkInputSchema, networkStateSchema, transitionNetwork,
} from './network';

export const packSchema = z.discriminatedUnion('pack', [leaseConfigSchema, cameraConfigSchema, networkConfigSchema]);
export const packStateSchema = z.discriminatedUnion('pack', [leaseStateSchema, cameraStateSchema, networkStateSchema]);

export type PackConfig = z.infer<typeof packSchema>;
export type PackState = z.infer<typeof packStateSchema>;

export const packContracts = {
  'lease-handoff@1': { inputSchema: leaseInputSchema, rubricId: 'compare-generation@1' },
  'camera-exposure@1': { inputSchema: cameraInputSchema, rubricId: 'motion-and-brightness@1' },
  'network-builder@1': { inputSchema: networkInputSchema, rubricId: 'route-through-proxy@1' },
} as const;

export function defaultPack(pack: string): PackConfig | null {
  switch (pack) {
    case 'lease-handoff@1': return structuredClone(leaseDefaults);
    case 'camera-exposure@1': return structuredClone(cameraDefaults);
    case 'network-builder@1': return structuredClone(networkDefaults);
    default: return null;
  }
}

export function initialState(config: PackConfig): PackState {
  switch (config.pack) {
    case 'lease-handoff@1': return initialLease(config);
    case 'camera-exposure@1': return initialCamera(config);
    case 'network-builder@1': return initialNetwork(config);
  }
}

export function transition(config: PackConfig, state: PackState, input: unknown): { state: PackState; assessment?: Assessment } {
  switch (config.pack) {
    case 'lease-handoff@1': return transitionLease(config, leaseStateSchema.parse(state), input);
    case 'camera-exposure@1': return transitionCamera(config, cameraStateSchema.parse(state), input);
    case 'network-builder@1': return transitionNetwork(config, networkStateSchema.parse(state), input);
  }
}
