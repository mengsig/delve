import type { Depth } from '../../../shared/domain';
import type { WorkspaceGraph } from '../../../shared/graph';
import { masteryLimits } from '../../../shared/mastery-limits';
import type { ReaderMastery } from '../../../shared/reader';
import { buildAtlas, isLearned, type AtlasConcept } from '../atlas/model';

export type CommittedCheckProgress = Pick<ReaderMastery, 'stage' | 'correctAnswers' | 'attempts'>;

export interface StudyGraph extends WorkspaceGraph {
  committedChecks?: ReadonlyMap<number, CommittedCheckProgress>;
}

export type ProgressState = 'mastered' | 'in-progress' | 'ready' | 'locked';

export interface ConceptProgress {
  id: number;
  title: string;
  onAtlas: boolean;
  streak: number | null;
  target: number;
  state: ProgressState;
  prerequisites: number[];
  unmet: { id: number; title: string }[];
}

export interface LearningProgress {
  available: boolean;
  depth: Depth;
  mastered: number;
  total: number;
  target: number;
  concepts: ConceptProgress[];
  byId: Map<number, ConceptProgress>;
  preferredId?: number;
}

function describeConcept(concept: AtlasConcept, onAtlas: boolean, target: number, streak: number | undefined,
  attempted: boolean, mastered: boolean, unmet: ConceptProgress['unmet']): ConceptProgress {
  const state = mastered ? 'mastered' : attempted || concept.evidence?.status === 'partial' ? 'in-progress'
    : unmet.length ? 'locked' : 'ready';
  return { id: concept.id, title: concept.title, onAtlas, streak: streak ?? null, target, state, unmet,
    prerequisites: concept.prerequisites.map(prior => prior.id) };
}

export function buildLearningProgress(graph: StudyGraph, depth: Depth): LearningProgress {
  const model = buildAtlas(graph, depth);
  const projection = graph.progress?.depth === depth ? graph.progress : undefined;
  const atlas = graph.atlasConceptIds ? new Set(graph.atlasConceptIds) : undefined;
  const saved = new Map(projection?.checks.map(check => [check.conceptId, check]));
  const committed = graph.committedChecks;
  const [target] = masteryLimits[depth];
  const verified = (concept: AtlasConcept) =>
    isLearned(concept) || committed?.get(concept.id)?.stage === 'understood';
  const concepts = model.layers.flatMap(layer => layer.map(concept => {
    const local = committed?.get(concept.id);
    const check = saved.get(concept.id);
    const unmet = concept.prerequisites.filter(prior => !verified(prior)).map(({ id, title }) => ({ id, title }));
    return describeConcept(concept, atlas?.has(concept.id) ?? true, target, local?.correctAnswers ?? check?.streak,
      local ? local.attempts > 0 : check?.attempted ?? false, verified(concept), unmet);
  }));
  const included = concepts.filter(concept => concept.onAtlas);
  const mastered = included.filter(concept => concept.state === 'mastered').length;
  const byId = new Map(concepts.map(concept => [concept.id, concept]));
  if (byId.size !== model.byId.size || mastered > included.length) throw new Error('Workspace progress is inconsistent.');
  return { available: projection !== undefined, depth, mastered, total: included.length, target,
    concepts, byId, preferredId: graph.suggestions?.[depth]?.conceptId };
}

export function eligibleNext(progress: LearningProgress, excludeConceptId?: number): ConceptProgress | undefined {
  const eligible = progress.concepts.filter(concept => concept.onAtlas && concept.id !== excludeConceptId
    && concept.state !== 'mastered' && concept.unmet.length === 0);
  const dependents = excludeConceptId === undefined ? [] : eligible.filter(concept => concept.prerequisites.includes(excludeConceptId));
  const pool = dependents.length ? dependents : eligible;
  return pool.find(concept => concept.id === progress.preferredId)
    ?? pool.find(concept => (concept.streak ?? 0) > 0)
    ?? pool.find(concept => concept.state === 'in-progress') ?? pool[0];
}
