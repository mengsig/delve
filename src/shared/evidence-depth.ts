import { DEPTHS, type Depth } from './domain';
import type { GraphEvidence } from './graph';

export function coversDepth(evidence: Depth, wanted: Depth): boolean {
  return DEPTHS.indexOf(evidence) >= DEPTHS.indexOf(wanted);
}

export function deepestEvidence<T extends { depth: Depth }>(current: T | undefined, candidate: T): T {
  return current && coversDepth(current.depth, candidate.depth) ? current : candidate;
}

export function demonstratedEvidence(evidence: readonly GraphEvidence[]): Map<number, GraphEvidence> {
  const deepest = new Map<number, GraphEvidence>();
  for (const entry of evidence) {
    if (entry.status !== 'demonstrated') continue;
    deepest.set(entry.conceptId, deepestEvidence(deepest.get(entry.conceptId), entry));
  }
  return deepest;
}
