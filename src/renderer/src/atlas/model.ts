import type { Depth } from '../../../shared/domain';
import type { GraphConcept, GraphEvidence, WorkspaceGraph } from '../../../shared/graph';

export interface AtlasConcept extends GraphConcept {
  prerequisites: AtlasConcept[];
  dependents: AtlasConcept[];
  evidence?: GraphEvidence;
  layer: number;
}

export interface AtlasModel {
  byId: Map<number, AtlasConcept>;
  layers: AtlasConcept[][];
  learned: number;
}

export function isLearned(concept: AtlasConcept): boolean {
  return concept.evidence?.status === 'demonstrated';
}

function dependencyLayers(concepts: Map<number, AtlasConcept>): AtlasConcept[][] {
  const remaining = new Map<number, number>();
  let next: AtlasConcept[] = [];
  for (const concept of concepts.values()) {
    remaining.set(concept.id, concept.prerequisites.length);
    if (!concept.prerequisites.length) next.push(concept);
  }
  const layers: AtlasConcept[][] = [];
  let visited = 0;
  while (next.length) {
    const current = next;
    next = [];
    for (const concept of current) {
      concept.layer = layers.length;
      visited++;
      for (const dependent of concept.dependents) {
        const count = remaining.get(dependent.id);
        if (!count) throw new Error('Invalid prerequisite count for ' + dependent.title);
        remaining.set(dependent.id, count - 1);
        if (count === 1) next.push(dependent);
      }
    }
    layers.push(current);
  }
  if (visited !== concepts.size) throw new Error('The workspace contains a prerequisite cycle.');
  return layers;
}

export function buildAtlas(graph: WorkspaceGraph, depth: Depth): AtlasModel {
  const byId = new Map<number, AtlasConcept>();
  for (const concept of graph.concepts) {
    if (byId.has(concept.id)) throw new Error('Duplicate concept in workspace graph: ' + concept.id);
    byId.set(concept.id, { ...concept, prerequisites: [], dependents: [], layer: 0 });
  }
  for (const { conceptId, prerequisiteId } of graph.edges) {
    const concept = byId.get(conceptId);
    const prior = byId.get(prerequisiteId);
    if (!concept || !prior) throw new Error('A prerequisite edge points outside this workspace.');
    concept.prerequisites.push(prior);
    prior.dependents.push(concept);
  }
  let learned = 0;
  for (const evidence of graph.evidence) {
    if (evidence.depth !== depth) continue;
    const concept = byId.get(evidence.conceptId);
    if (!concept) throw new Error('Evidence points outside this workspace.');
    if (concept.evidence) throw new Error('Duplicate evidence for a concept at the same depth.');
    if (!concept.portable && evidence.workspaceId !== graph.workspaceId) {
      throw new Error('Local evidence belongs to a different workspace.');
    }
    concept.evidence = evidence;
    if (isLearned(concept)) learned++;
  }
  return { byId, learned, layers: dependencyLayers(byId) };
}

export function statusText(concept: AtlasConcept, workspaceId: string, changed = false): string {
  const evidence = concept.evidence;
  if (!evidence) return changed ? 'Changed in #184' : 'Not yet learned';
  if (evidence.status === 'partial') return 'Partially demonstrated';
  if (evidence.status === 'revisit') return 'Marked for revisit';
  if (evidence.workspaceId === workspaceId) return 'Learned here';
  return evidence.workspaceName ? 'Known from ' + evidence.workspaceName : 'Learned · portable evidence';
}

export function nextConcept(model: AtlasModel, preferred?: AtlasConcept): AtlasConcept | undefined {
  let best: AtlasConcept | undefined;
  let bestScore = -1;
  for (const concept of model.byId.values()) {
    if (isLearned(concept) || !concept.prerequisites.every(isLearned)) continue;
    const score = (concept.evidence ? 4 : 0) + (concept === preferred ? 2 : 0)
      + (concept.prerequisites.length > 0 ? 1 : 0);
    if (score > bestScore) {
      best = concept;
      bestScore = score;
    }
  }
  return best ?? preferred ?? model.layers[0]?.[0];
}
