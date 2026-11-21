import type { Depth, Workspace } from '../../shared/domain';

export const DEMO_CONCEPTS = {
  queue: ['Durable queue', 'A task survives the worker that accepted it.'],
  clock: ['Lease clock', 'A time limit lets abandoned work become eligible again.'],
  lease: ['Worker leases', 'Give a worker temporary ownership without stranding a task if the worker disappears.'],
  fence: ['Write fencing', 'A late worker must not overwrite a newer owner’s result.'],
  journal: ['Event journal', 'A durable record tells you what happened after the daemon stops.'],
  recovery: ['Recovery', 'A restarted daemon can continue safely without silently losing work.'],
  delivery: ['Delivery loop', 'Relay drains queued work into an external receiver.'],
  retry: ['Retry policy', 'A delivery can fail temporarily without being lost.'],
  light: ['Available light', 'An image begins with light falling on the scene.'],
  frame: ['Framing', 'Choose the part of the scene that tells the story.'],
  exposure: ['Moving subjects', 'Capture a rider sharply without letting the frame go dark.'],
  shutter: ['Shutter speed', 'Exposure time determines how far moving edges travel during capture.'],
  iso: ['Sensor gain', 'ISO can change recorded brightness without shortening motion trails.'],
  pan: ['Panning', 'Following a subject can separate a moving rider from the background.'],
} as const;

export type DemoConceptId = keyof typeof DEMO_CONCEPTS;
export const DEMO_PORTABLE: ReadonlySet<DemoConceptId> = new Set(['queue', 'clock', 'light', 'frame']);

export interface DemoWorkspace {
  id: string;
  title: string;
  kind: 'github' | 'topic';
  snapshot?: string;
  concepts: readonly DemoConceptId[];
  edges: ReadonlyArray<readonly [prerequisite: DemoConceptId, concept: DemoConceptId]>;
  evidence?: ReadonlyArray<readonly [concept: DemoConceptId, depths: readonly Depth[]]>;
}

export const DEMO_WORKSPACES: readonly DemoWorkspace[] = [
  {
    id: 'de100000-0000-4000-8000-000000000001',
    title: 'Archon',
    kind: 'github',
    snapshot: '8c2a1d7',
    concepts: ['queue', 'clock', 'lease', 'fence', 'journal', 'recovery'],
    edges: [['queue', 'lease'], ['clock', 'lease'], ['lease', 'fence'], ['queue', 'journal'], ['fence', 'recovery'], ['journal', 'recovery']],
  },
  {
    id: 'de100000-0000-4000-8000-000000000002',
    title: 'Relay',
    kind: 'github',
    snapshot: 'f3a927b',
    concepts: ['queue', 'clock', 'delivery', 'retry', 'journal', 'recovery'],
    edges: [['queue', 'delivery'], ['clock', 'retry'], ['delivery', 'retry'], ['delivery', 'journal'], ['retry', 'recovery'], ['journal', 'recovery']],
    evidence: [['queue', ['high', 'medium', 'low']], ['clock', ['high', 'medium']], ['delivery', ['high']], ['journal', ['high']]],
  },
  {
    id: 'de100000-0000-4000-8000-000000000003',
    title: 'Photography',
    kind: 'topic',
    concepts: ['light', 'frame', 'exposure', 'shutter', 'iso', 'pan'],
    edges: [['light', 'exposure'], ['frame', 'exposure'], ['exposure', 'shutter'], ['light', 'iso'], ['shutter', 'pan'], ['iso', 'pan']],
    evidence: [['light', ['high', 'medium']], ['frame', ['high', 'medium']]],
  },
];

export function matchesDemo(workspace: Workspace): boolean {
  return DEMO_WORKSPACES.some(demo => demo.id === workspace.id && workspace.source === `Demo: ${demo.title}`);
}
