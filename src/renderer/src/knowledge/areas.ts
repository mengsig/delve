import type { GlobalKnowledgeGraph, KnowledgeConcept, KnowledgeMembership } from '../../../shared/knowledge';
import type { ConceptProgress, LearningProgress, ProgressState } from '../progress/model';
import { canStartNext, eligibleNext } from '../progress/model';
import { anyWorkspace, type Filters } from './view';

export interface LearningArea extends KnowledgeMembership {
  progress: LearningProgress;
}
export const stateLabels: Record<ProgressState, string> = { mastered: 'Mastered', 'in-progress': 'In progress', ready: 'Ready', locked: 'Locked' };

export function mapWorkspaces(graph: GlobalKnowledgeGraph): KnowledgeMembership[] {
  const unique = new Map<string, KnowledgeMembership>();
  for (const concept of graph.concepts) {
    for (const workspace of concept.memberships) unique.set(workspace.workspaceId, workspace);
  }
  return [...unique.values()].sort((a, b) => a.workspaceName.localeCompare(b.workspaceName) || a.workspaceId.localeCompare(b.workspaceId));
}

export function graphInArea(graph: GlobalKnowledgeGraph, workspace: string): GlobalKnowledgeGraph {
  if (workspace === anyWorkspace) return graph;
  const concepts = graph.concepts.filter(c => c.memberships.some(w => w.workspaceId === workspace));
  const ids = new Set(concepts.map(c => c.id));
  return { concepts, edges: graph.edges.filter(e => ids.has(e.conceptId) && ids.has(e.prerequisiteId)),
    links: graph.links.filter(link => ids.has(link.fromConceptId) && ids.has(link.toConceptId)) };
}

export interface Place {
  area: LearningArea;
  progress: ConceptProgress;
  state: ProgressState;
}

export function mapPlaces(graph: GlobalKnowledgeGraph, areas: LearningArea[], preferred?: string) {
  const places = new Map<number, Place>();
  const byWorkspace = new Map(areas.map(area => [area.workspaceId, area]));
  for (const concept of graph.concepts) {
    const candidates = concept.memberships.flatMap(w => {
      const area = byWorkspace.get(w.workspaceId);
      const progress = area?.progress.byId.get(concept.id);
      return area && progress ? [{ area, progress }] : [];
    });
    const preferredPlace = candidates.find(p => p.area.workspaceId === preferred);
    const eligible = ({ area, progress }: typeof candidates[number]) => area.progress.available && canStartNext(progress);
    const place = preferredPlace && eligible(preferredPlace) ? preferredPlace : candidates.find(eligible)
      ?? (preferredPlace?.progress.onAtlas ? preferredPlace : candidates.find(p => p.progress.onAtlas)) ?? preferredPlace ?? candidates[0];
    if (!place) continue;
    const { area, progress } = place;
    const state = progress.state !== 'mastered' && progress.unmet.length ? 'locked' : progress.state;
    places.set(concept.id, { area, progress, state });
  }
  return places;
}

function matches(concept: KnowledgeConcept, state: ProgressState | undefined, filters: Filters, query: string, originalTitle = '') {
  if (filters.depth && filters.depth !== concept.masteredDepth) return false;
  if (query && ![concept.title, concept.summary, originalTitle].join(' ').toLocaleLowerCase().includes(query)) return false;
  if (filters.state === 'verified') return concept.masteredDepth !== null;
  if (filters.state === 'skipped' && concept.masteryState !== 'skipped') return false;
  if (filters.state === 'unstarted' && concept.masteryState !== 'not-started') return false;
  if (filters.state && !['skipped', 'unstarted'].includes(filters.state) && state !== filters.state) return false;
  return true;
}

export function visibleConcepts(graph: GlobalKnowledgeGraph, places: ReadonlyMap<number, Place>, filters: Filters,
  originalTitles?: ReadonlyMap<number, string>) {
  const query = filters.query.trim().toLocaleLowerCase();
  return new Set(graph.concepts.filter(c => matches(c, places.get(c.id)?.state, filters, query, originalTitles?.get(c.id))).map(c => c.id));
}

export function suggestedLesson(areas: LearningArea[], places: ReadonlyMap<number, Place>, visible: Set<number>, preferred?: string) {
  const ordered = [...areas].sort((a, b) => Number(b.workspaceId === preferred) - Number(a.workspaceId === preferred));
  for (const area of ordered) {
    if (!area.progress.available) continue;
    const concepts = area.progress.concepts.filter(c => visible.has(c.id) && places.get(c.id)?.area === area);
    const next = eligibleNext({ ...area.progress, concepts });
    if (next) return next.id;
  }
  return null;
}

export function neighbourhood(graph: GlobalKnowledgeGraph, id: number) {
  const ids = new Set([id]);
  for (const edge of graph.edges) {
    if (edge.conceptId === id) ids.add(edge.prerequisiteId);
    if (edge.prerequisiteId === id) ids.add(edge.conceptId);
  }
  for (const link of graph.links) {
    if (link.fromConceptId === id) ids.add(link.toConceptId);
    if (link.toConceptId === id) ids.add(link.fromConceptId);
  }
  return ids;
}
