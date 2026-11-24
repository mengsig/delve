import { describe, expect, it } from 'vitest';
import { beginKnowledgeTrip, previousPage, routeForActivity, routeForTutorJob, visitRoute, type Route } from './navigation';

function knowledgeHistory() {
  return visitRoute({ entries: [{ screen: 'atlas', conceptId: 1 }] }, { screen: 'knowledge' });
}

describe('Knowledge return history', () => {
  it.each([
    { screen: 'lesson', conceptId: 5 },
    { screen: 'lesson', conceptId: 5, review: true },
    { screen: 'atlas', conceptId: 5 },
    { screen: 'progress' },
  ] satisfies Extract<Route, { screen: 'lesson' | 'atlas' | 'progress' }>[])(
    'returns from $screen with the original workspace, depth, and Knowledge entry',
    destination => {
      const history = knowledgeHistory();
      const trip = beginKnowledgeTrip(history, 'origin-workspace', 'low', destination);
      expect(trip.entries).toEqual([destination]);
      const back = previousPage(trip);
      expect(back).toMatchObject({ workspaceId: 'origin-workspace', depth: 'low' });
      expect(back.entries).toBe(history.entries);
      expect(back.entries.at(-1)).toBe(history.entries.at(-1));
    },
  );

  it('keeps the return available after visiting another destination inside the workspace', () => {
    const history = knowledgeHistory();
    const trip = beginKnowledgeTrip(history, 'origin-workspace', 'high', { screen: 'atlas', conceptId: 5 });
    const lesson = visitRoute(trip, { screen: 'lesson', conceptId: 5 });
    const backToAtlas = previousPage(lesson);
    expect(backToAtlas).toEqual(trip);
    expect(previousPage(backToAtlas).entries).toBe(history.entries);
  });

  it('keeps the Knowledge entry on Back and creates a fresh view on a fresh visit', () => {
    const history = knowledgeHistory();
    expect(visitRoute(history, { screen: 'knowledge' })).toBe(history);
    const setup = visitRoute(history, { screen: 'setup' });
    const original = previousPage(setup).entries.at(-1);
    const reopened = visitRoute(previousPage(history), { screen: 'knowledge' }).entries.at(-1);
    expect(original).toBe(history.entries.at(-1));
    expect(original?.screen).toBe('knowledge');
    expect(reopened?.screen).toBe('knowledge');
    if (original?.screen !== 'knowledge' || reopened?.screen !== 'knowledge') {
      throw new Error('Expected two Knowledge history entries.');
    }
    expect(original.view).not.toBe(reopened.view);
  });

  it('requires a Knowledge entry and a workspace to start a round trip', () => {
    const atlas = { screen: 'atlas' } as const;
    expect(() => beginKnowledgeTrip({ entries: [atlas] }, 'workspace', 'medium', atlas))
      .toThrow('Open this destination from Knowledge.');
    expect(() => beginKnowledgeTrip(knowledgeHistory(), '', 'medium', atlas))
      .toThrow('Select a workspace before opening a Knowledge destination.');
  });

  it('retains the standard route and Atlas fallback outside Knowledge', () => {
    const start = { entries: [{ screen: 'atlas' }] } as const;
    const lesson = visitRoute(start, { screen: 'lesson', conceptId: 2 });
    const progress = visitRoute(lesson, { screen: 'progress' });
    expect(previousPage(progress)).toEqual(lesson);
    expect(previousPage(lesson)).toEqual(start);
    expect(previousPage(start)).toEqual(start);
  });
});


describe('recent activity navigation', () => {
  it.each(['lesson', 'environment'] as const)('restores a pinned %s at its saved depth', kind => {
    const common = { workspaceId: 'workspace', conceptId: 7, title: 'Lesson', depth: 'low' as const, lessonId: 42 };
    const entry = kind === 'lesson' ? { ...common, kind } : { ...common, kind, blockKey: 'opening/0' };
    expect(routeForActivity(entry)).toMatchObject({ screen: 'lesson', conceptId: 7, lessonId: 42, lessonDepth: 'low' });
    expect(routeForActivity(entry)).toHaveProperty('environment', kind === 'environment' ? 'opening/0' : undefined);
  });

  it('keeps legacy unpinned activities unpinned', () => {
    expect(routeForActivity({ kind: 'lesson', workspaceId: 'workspace', conceptId: 7, title: 'Lesson', depth: 'high' }))
      .toMatchObject({ screen: 'lesson', conceptId: 7, lessonId: undefined, lessonDepth: undefined });
  });
});


describe('tutor job navigation', () => {
  it('opens the pinned lesson at the job depth', () => {
    expect(routeForTutorJob({ workspaceId: 'workspace', conceptId: 7, depth: 'medium', lessonId: 42 }))
      .toEqual({ screen: 'lesson', conceptId: 7, lessonId: 42, lessonDepth: 'medium' });
    expect(routeForTutorJob({ workspaceId: 'workspace', conceptId: 7, depth: 'low' }))
      .toEqual({ screen: 'lesson', conceptId: 7, lessonId: undefined, lessonDepth: undefined });
  });
});
