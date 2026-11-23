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

  it('restores focus lost to the disabled form, or kept on the source', () => {
    expect(shouldFocusSource(body, body, source)).toBe(true);
    expect(shouldFocusSource(null, body, source)).toBe(true);
    expect(shouldFocusSource(source, body, source)).toBe(true);
  });

  it('never takes focus from an element the user moved to', () => {
    const advanced = { id: 'advanced-options' } as unknown as Element;
    expect(shouldFocusSource(advanced, body, source)).toBe(false);
    expect(shouldFocusSource(body, body, null)).toBe(false);
  });
});
