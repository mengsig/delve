import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { KnowledgeConcept } from '../../../shared/knowledge';
import { SharedMarker, UsedIn } from './SharedUsage';

const concept: KnowledgeConcept = {
  id: 1, key: 'queue', title: 'Queue', summary: '', portable: true,
  memberships: [{ workspaceId: 'a', workspaceName: 'Alpha' }, { workspaceId: 'b', workspaceName: 'Beta' }],
  masteryState: 'verified', masteredDepth: 'medium', evidenceRevision: 1, learnedAt: null,
  learnedWorkspaceId: 'a', bridge: true,
};

describe('shared concept usage', () => {
  it('marks portable concepts and lists their workspaces', () => {
    expect(renderToStaticMarkup(createElement(SharedMarker, { concept }))).toContain('Shared across repositories');
    const usage = renderToStaticMarkup(createElement(UsedIn, { concept }));
    expect(usage).toContain('<h4>Used in</h4>');
    expect(usage).toContain('<li>Alpha</li><li>Beta</li>');
  });

  it('marks a portable concept before a second repository uses it', () => {
    expect(renderToStaticMarkup(createElement(SharedMarker, { concept: { ...concept, memberships: concept.memberships.slice(0, 1) } })))
      .toContain('Shared across repositories');
    expect(renderToStaticMarkup(createElement(SharedMarker, { concept: { ...concept, portable: false } }))).toBe('');
    expect(renderToStaticMarkup(createElement(UsedIn, { concept: { ...concept, memberships: [] } }))).toBe('');
  });
});
