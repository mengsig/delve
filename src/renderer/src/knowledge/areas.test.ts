import { describe, expect, it } from 'vitest';
import type { KnowledgeConcept, GlobalKnowledgeGraph } from '../../../shared/knowledge';
import { buildLearningProgress, type StudyGraph } from '../progress/model';
import { areaSummary, graphInArea, mapPlaces, neighbourhood, suggestedLesson, visibleConcepts, type LearningArea } from './areas';
import { anyWorkspace } from './view';

const alpha = { workspaceId: 'alpha', workspaceName: 'Alpha' };
const beta = { workspaceId: 'beta', workspaceName: 'Beta' };
const concepts = ['Foundation', 'Shared idea', 'Change only'].map((title, index): KnowledgeConcept => ({
  id: index + 1, title, key: String(index), summary: '', portable: true,
  memberships: index === 1 ? [alpha, beta] : [alpha], masteryState: 'not-started', masteredDepth: null,
  learnedAt: null, learnedWorkspaceId: null, evidenceRevision: null, bridge: index === 1,
}));
const graph: GlobalKnowledgeGraph = {
  concepts, edges: [{ conceptId: 2, prerequisiteId: 1 }], links: [],
};
const filters = { workspace: anyWorkspace, state: '', depth: '', query: '', group: false };

function area(workspace: typeof alpha): LearningArea {
  const local = graphInArea(graph, workspace.workspaceId);
  const source: StudyGraph = { ...local, workspaceId: workspace.workspaceId, demo: false, evidence: [], snapshot: null,
    atlasConceptIds: local.concepts.filter(c => c.id !== 3).map(c => c.id), progress: { depth: 'medium', checks: [] } };
  return { ...workspace, progress: buildLearningProgress(source, 'medium') };
}

describe('scoped knowledge recommendations', () => {
  it('summarizes the full area population including change-only and shared concepts', () => {
    const first = area(alpha);
    const second = area(beta);
    first.progress.byId.get(1)!.state = 'mastered';
    first.progress.byId.get(3)!.state = 'mastered';
    const areas = [first, second];
    const places = mapPlaces(graph, areas, alpha.workspaceId);
    expect(areaSummary(graph, areas, places, anyWorkspace)).toEqual({ name: 'All workspaces', mastered: 2, total: 3, available: true });
    const betaGraph = graphInArea(graph, beta.workspaceId);
    expect(areaSummary(betaGraph, [second], mapPlaces(betaGraph, [second]), beta.workspaceId))
      .toEqual({ name: 'Beta', mastered: 0, total: 1, available: true });
    second.progress.available = false;
    expect(areaSummary(graph, areas, places, anyWorkspace).available).toBe(false);
    expect(visibleConcepts(graph, places, { ...filters, query: 'change' }).size).toBe(1);
    expect(areaSummary(graph, areas, places, anyWorkspace).total).toBe(3);
  });
  it('uses the chosen area’s prerequisites and excludes change-only concepts from next lessons', () => {
    const first = area(alpha);
    const places = mapPlaces(graph, [first], alpha.workspaceId);
    const visible = visibleConcepts(graph, places, filters);
    expect(suggestedLesson([first], places, visible)).toBe(1);
    expect(places.get(2)?.state).toBe('locked');
    expect(places.get(2)?.progress.unmet).toEqual([{ id: 1, title: 'Foundation' }]);
    expect(suggestedLesson([first], places, new Set([2, 3]))).toBeNull();
    expect(visibleConcepts(graph, places, { ...filters, state: 'locked' })).toEqual(new Set([2]));
  });

  it('can start a shared concept in its eligible area from the global view', () => {
    const areas = [area(alpha), area(beta)];
    const places = mapPlaces(graph, areas, alpha.workspaceId);
    const visible = visibleConcepts(graph, places, { ...filters, query: ' SHAREd ' });
    expect(places.size).toBe(3);
    expect(places.get(2)?.area.workspaceId).toBe(beta.workspaceId);
    expect(suggestedLesson(areas, places, visible, alpha.workspaceId)).toBe(2);
    expect(graphInArea(graph, beta.workspaceId).concepts.map(c => c.id)).toEqual([2]);
    expect(neighbourhood(graph, 2)).toEqual(new Set([1, 2]));
  });

  it('counts a shared concept on its reviewed path when its preferred workspace uses it only in a change', () => {
    const first = area(alpha);
    const second = area(beta);
    first.progress.byId.get(2)!.onAtlas = false;
    second.progress.byId.get(2)!.state = 'mastered';
    const places = mapPlaces(graph, [first, second], alpha.workspaceId);
    expect(places.get(2)?.area.workspaceId).toBe(beta.workspaceId);
    expect(places.get(2)?.state).toBe('mastered');
    expect(suggestedLesson([first, second], places, new Set([2]))).toBeNull();
  });

  it('withholds guidance when the scoped check projection is unavailable', () => {
    const first = area(alpha);
    first.progress.available = false;
    const places = mapPlaces(graph, [first]);
    expect(places.get(1)?.state).toBe('ready');
    expect(suggestedLesson([first], places, new Set([1]))).toBeNull();
  });
});
