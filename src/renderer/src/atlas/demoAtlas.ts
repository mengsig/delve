import type { WorkspaceGraph } from '../../../shared/graph';
import type { AtlasConcept, AtlasModel } from './model';

const FIXTURES = {
  lease: {
    blurb: 'Follow a task from the queue to a safe handoff.',
    feature: 'journal',
    order: ['queue', 'clock', 'lease', 'fence', 'journal', 'recovery'],
  },
  delivery: {
    blurb: 'Follow a delivery from storage to acknowledgment.',
    feature: 'retry',
    order: ['queue', 'clock', 'delivery', 'retry', 'journal', 'recovery'],
  },
  exposure: {
    blurb: 'Study how time, light and movement shape a photograph.',
    feature: 'pan',
    order: ['light', 'frame', 'exposure', 'shutter', 'iso', 'pan'],
  },
} as const;

export interface DemoPlate {
  blurb: string;
  primary: AtlasConcept;
  feature?: AtlasConcept;
  changed?: AtlasConcept;
  order: readonly string[];
}

export function keySegment(key: string): string {
  return key.slice(key.lastIndexOf(':') + 1);
}

export function demoPlate(graph: WorkspaceGraph, model: AtlasModel): DemoPlate | undefined {
  if (!graph.demo) return undefined;
  const byKey = new Map(Array.from(model.byId.values(), concept => [keySegment(concept.key), concept]));
  for (const [key, fixture] of Object.entries(FIXTURES)) {
    const primary = byKey.get(key);
    if (!primary) continue;
    return {
      ...fixture, primary, feature: byKey.get(fixture.feature),
      changed: key === 'lease' ? byKey.get('fence') : undefined,
    };
  }
  return undefined;
}
