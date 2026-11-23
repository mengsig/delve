import { describe, expect, it } from 'vitest';
import { IpcCallError } from './api';
import { SourceError, shouldFocusSource, sourceInput, sourceRejection } from './sourceErrors';

describe('setup source errors', () => {
  it('turns local validation failures into source errors', () => {
    expect(() => sourceInput('topic', '  ')).toThrow(SourceError);
    expect(() => sourceInput('github', 'octo/site/pull/1')).toThrow('Use a GitHub repository URL');
    expect(sourceInput('github', 'octo/site')).toEqual({ kind: 'github', owner: 'octo', repo: 'site' });
  });

  it.each(['INVALID_REQUEST', 'INVALID_WORKSPACE', 'NOT_A_GIT_REPOSITORY'])('marks a %s rejection as a source error', (code) => {
    const rejected = sourceRejection(new IpcCallError(code, '/tmp is not a Git repository'));
    expect(rejected).toBeInstanceOf(SourceError);
    expect((rejected as SourceError).message).toBe('/tmp is not a Git repository');
  });

  it.each([
    new IpcCallError('DUPLICATE_WORKSPACE', 'Already added.'),
    new IpcCallError('INTERNAL', 'Something went wrong.'),
    new Error('The preload bridge rejected the call.'),
  ])('leaves unrelated failures unchanged: %s', (cause) => {
    expect(sourceRejection(cause)).toBe(cause);
  });
});

describe('source error focus', () => {
  const body = { id: 'body' } as unknown as Element;
  const source = { id: 'source-input' } as unknown as Element;
  const submit = { id: 'submit' } as unknown as Element;
  const still = { start: submit, moved: false };

  it('restores focus lost to the disabled form, kept on the source, or left where submit put it', () => {
    expect(shouldFocusSource(still, body, body, source)).toBe(true);
    expect(shouldFocusSource(still, null, body, source)).toBe(true);
    expect(shouldFocusSource(still, source, body, source)).toBe(true);
    expect(shouldFocusSource(still, submit, body, source)).toBe(true);
    expect(shouldFocusSource(null, body, body, source)).toBe(true);
  });

  it('never takes focus once the user moved it during the request, even back to the page', () => {
    const advanced = { id: 'advanced-options' } as unknown as Element;
    expect(shouldFocusSource({ start: submit, moved: true }, body, body, source)).toBe(false);
    expect(shouldFocusSource(still, advanced, body, source)).toBe(false);
    expect(shouldFocusSource(null, advanced, body, source)).toBe(false);
    expect(shouldFocusSource(still, body, body, null)).toBe(false);
  });
});
