import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { LessonRail } from './Mastery';

type RailProps = Parameters<typeof LessonRail>[0];

it('shows depth-appropriate prerequisite titles in the path meter and action', () => {
  const graph = {
    workspaceId: 'workspace', snapshot: null, demo: false,
    concepts: [
      { id: 1, key: 'retry', title: 'Retry budget in dispatch.ts', summary: '', portable: true },
      { id: 2, key: 'delivery', title: 'Delivery', summary: '', portable: true },
    ],
    atlasConceptIds: [1, 2], edges: [{ conceptId: 2, prerequisiteId: 1 }], evidence: [],
    progress: { depth: 'high', checks: [] },
  };
  const props = { graph, depth: 'high', conceptId: 2, onLesson: () => {}, onProgress: () => {} } as unknown as RailProps['props'];
  const mastery = { stage: 'checking', correctAnswers: 0, requiredCorrectAnswers: 1 } as RailProps['mastery'];
  const high = renderToStaticMarkup(createElement(LessonRail, { props, mastery, title: 'Delivery' }));
  expect(high).toContain('Open Retry budget');
  expect(high).toContain('aria-label="Retry budget"');
  expect(high).not.toContain('dispatch.ts');
  const low = renderToStaticMarkup(createElement(LessonRail, { props: { ...props, depth: 'low', graph: { ...graph, progress: { depth: 'low', checks: [] } } }, mastery, title: 'Delivery' }));
  expect(low).toContain('Open Retry budget in dispatch.ts');
  expect(low).toContain('aria-label="Retry budget in dispatch.ts"');
});
