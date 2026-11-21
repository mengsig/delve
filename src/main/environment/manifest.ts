import { z } from 'zod';
import { packContracts } from '../../shared/instruments';
import type { LabConfig, LabManifest } from '../../shared/lab-config';

const controlId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const eventSchemas = {
  'lease-handoff@1': z.toJSONSchema(packContracts['lease-handoff@1'].inputSchema),
  'camera-exposure@1': z.toJSONSchema(packContracts['camera-exposure@1'].inputSchema),
  'network-builder@1': z.toJSONSchema(packContracts['network-builder@1'].inputSchema),
  'bundle@1': z.toJSONSchema(controlId),
};

export function manifestFor(config: LabConfig, fallback: string): LabManifest {
  return { runtime: 'delve.env/1', config, eventSchema: eventSchemas[config.pack],
    rubric: config.pack === 'bundle@1' ? 'practice-only@1' : packContracts[config.pack].rubricId,
    fallback };
}
