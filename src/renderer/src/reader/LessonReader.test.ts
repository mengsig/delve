import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { ReaderMastery } from '../../../shared/reader';
import { LessonRecovery } from './LessonStart';
import { LessonNotes } from './LessonNotes';
import type { LessonTutor } from './Tutor';

it('offers a retry when a verified concept has no readable saved lesson', () => {
  const mastery: ReaderMastery = { stage: 'understood', revision: 'proof', attempts: 0, correctAnswers: 0,
    maxAttempts: 4, requiredCorrectAnswers: 2, activeCheck: null, appliedPassed: false, needsAdaptation: false };
  const tutor = { pending: false, signedIn: true, provider: 'codex' as const, prepare: vi.fn() };
  const body = { invalidLatest: true, revision: null, mastery };
  const markup = renderToStaticMarkup(createElement(LessonRecovery, { body, tutor }));
  expect(markup).toContain('<button>Retry lesson generation</button>');
  expect(markup).toContain('<button>Preview lesson request</button>');
  expect(renderToStaticMarkup(createElement(LessonRecovery, { body: { ...body, invalidLatest: false }, tutor }))).toBe('');
});

it('reports the actual depth and origin of deeper portable evidence in lesson notes', () => {
  const workspace = { id: 'review', kind: 'git' as const, name: 'Worker service', source: '/demo/worker',
    createdAt: 'now', lastOpenedAt: null };
  const graph = { workspaceId: workspace.id, snapshot: null, demo: true, edges: [],
    concepts: [{ id: 1, key: 'tcp', portable: true, title: 'TCP', summary: 'An ordered byte stream.' }],
    evidence: [{ conceptId: 1, depth: 'low' as const, source: 'check' as const, status: 'demonstrated' as const,
      workspaceId: 'origin', workspaceName: 'Dispatch service', note: '', revision: 1, recordedAt: 'now' }],
  };
  const mastery: ReaderMastery = { stage: 'understood', revision: null, attempts: 0, correctAnswers: 0,
    maxAttempts: 4, requiredCorrectAnswers: 2, activeCheck: null, appliedPassed: false, needsAdaptation: false };
  const noop = () => undefined;
  const markup = renderToStaticMarkup(createElement(LessonNotes, {
    props: { workspace, graph, depth: 'medium', conceptId: 1, view: 'folio', onDepth: noop, onBack: noop, onLesson: noop, onProgress: noop },
    body: { blocks: [], source: null, reused: true, invalidLatest: false, revision: null, messages: [], earlierMessages: false, mastery },
    tutor: { provider: 'demo' } as LessonTutor, busy: false, skip: noop, review: noop,
  }));
  expect(markup).toContain('Understood at low depth in Dispatch service.');
});
