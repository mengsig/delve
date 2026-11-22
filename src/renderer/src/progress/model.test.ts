import { expect, it } from 'vitest';
import type { GraphEvidence } from '../../../shared/graph';
import { buildLearningProgress, eligibleNext, type StudyGraph } from './model';

function evidence(conceptId: number, status: GraphEvidence['status'], depth = 'medium' as const): GraphEvidence {
  return { conceptId, status, depth, source: 'check', note: '', workspaceId: 'origin', workspaceName: 'Source', revision: 1, recordedAt: '' };
}

function fixture(): StudyGraph {
  return {
    workspaceId: 'workspace', snapshot: null, demo: false,
    concepts: ['Queue', 'Lease', 'Fence', 'Journal', 'Change only'].map((title, index) => ({
      id: index + 1, key: title.toLowerCase(), title, summary: '', portable: true,
    })),
    atlasConceptIds: [1, 2, 3, 4],
    edges: [{ conceptId: 2, prerequisiteId: 1 }, { conceptId: 3, prerequisiteId: 2 }],
    evidence: [evidence(1, 'demonstrated'), evidence(2, 'partial'), evidence(4, 'partial'), evidence(5, 'demonstrated')],
    progress: { depth: 'medium', checks: [{ conceptId: 2, streak: 1, attempted: true, lessonRevision: 'lesson',
      snapshot: null, masteryRevision: 'mastery' }] },
    suggestions: { medium: { conceptId: 3, reason: 'Learn the fence' } },
  };
}

it('aggregates verified Atlas membership and distinguishes saved from count-free partial evidence', () => {
  const graph = fixture();
  const model = buildLearningProgress(graph, 'medium');
  expect(model).toMatchObject({ mastered: 1, total: 4, target: 2, available: true });
  expect(model.byId.get(2)).toMatchObject({ state: 'in-progress', streak: 1 });
  expect(model.byId.get(3)).toMatchObject({ state: 'locked', unmet: [{ id: 2, title: 'Lease' }] });
  expect(model.byId.get(4)).toMatchObject({ state: 'in-progress', streak: null });
  expect(eligibleNext(model)?.id).toBe(2);
  expect(buildLearningProgress(graph, 'low')).toMatchObject({ mastered: 0, target: 3, available: false });
});

it('updates eligibility and workspace mastery together from a committed lesson result', () => {
  const graph = fixture();
  const mastery = { stage: 'understood', attempts: 2, correctAnswers: 2 } as const;
  const model = buildLearningProgress({ ...graph, committedChecks: new Map([[2, mastery]]) }, 'medium');
  expect(model.mastered).toBe(2);
  expect(model.byId.get(2)).toMatchObject({ state: 'mastered', streak: 2 });
  expect(eligibleNext(model, 2)?.id).toBe(3);
  expect(eligibleNext(model, 3)?.id).toBe(4);
});

it('plans local usage before any new portable lesson when another repository proved the foundation', () => {
  const graph = fixture();
  graph.concepts = [
    { id: 1, key: 'tcp', title: 'TCP', summary: '', portable: true },
    { id: 2, key: 'lease-transport', title: 'Lease transport', summary: '', portable: false },
  ];
  graph.evidence = [evidence(1, 'demonstrated')];
  graph.edges = [{ conceptId: 2, prerequisiteId: 1 }];
  graph.progress = { depth: 'medium', checks: [] };
  graph.suggestions = { medium: { conceptId: 1, reason: 'Review the transport.' } };
  const selected = buildLearningProgress(graph, 'medium');
  expect(selected.byId.get(1)?.state).toBe('mastered');
  expect(selected.concepts.filter(c => c.state === 'ready').map(c => c.id)).toEqual([2]);
  expect(eligibleNext(selected)?.id).toBe(2);
  expect(eligibleNext(buildLearningProgress(graph, 'high'))?.id).toBe(2);
  expect(eligibleNext(buildLearningProgress(graph, 'low'))?.id).toBe(1);
});
