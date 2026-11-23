import { describe, expect, it } from 'vitest';
import { patchLines } from '../../shared/change-diff';
import { bindConceptSpans } from './concept-spans';

const path = 'src/dispatch.ts';
const patch = ['--- a/src/dispatch.ts', '+++ b/src/dispatch.ts', '@@ -3,2 +7,3 @@ dispatch',
  ' context', '---old', '+++new', '+next', '@@ -20 +42 @@', '-old', '+new', ''].join('\n');
const files = [{ path, patch }];
const concepts = new Map([['dispatch', 12]]);
const span = { path, key: 'dispatch', side: 'new' as const, start: 8, end: 9 };

describe('source-linked concepts', () => {
  it('binds the correct side and hunk, including changed text resembling a file header', () => {
    const removed = { ...span, side: 'old' as const, start: 4, end: 4 };
    const last = { ...span, start: 42, end: 42 };
    expect(bindConceptSpans([span, removed, last], files, concepts)).toEqual([
      { path, side: 'new', start: 8, end: 9, conceptId: 12 },
      { path, side: 'old', start: 4, end: 4, conceptId: 12 },
      { path, side: 'new', start: 42, end: 42, conceptId: 12 },
    ]);
    expect(patchLines(patch)).toContainEqual({ kind: 'context', oldLine: 3, newLine: 7, text: ' context' });
  });

  it('drops unapproved spans while preserving the valid links from the same reply', () => {
    const invalid = [{ path: 'other.ts' }, { side: 'old' as const }, { start: 0 }, { end: 7 },
      { start: 7 }, { end: 42 }, { start: 21, end: 21 }].map(range => ({ ...span, ...range }));
    expect(bindConceptSpans([...invalid, span], files, concepts)).toEqual([
      { path, side: 'new', start: 8, end: 9, conceptId: 12 },
    ]);
  });

  it('rejects links to concepts outside the change footprint', () => {
    expect(() => bindConceptSpans([{ ...span, key: 'other' }], files, concepts)).toThrow(/outside the change footprint/);
  });
});
