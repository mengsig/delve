import { describe, expect, it } from 'vitest';
import { DomainError } from '../../shared/errors';
import { gitReadState, gitOutput } from './git-diagnostics';

describe('Git read diagnostics', () => {
  it.each([
    ['single quotes', "fatal: cannot read 'synthetic-one\nerror: synthetic-two'", 'fatal: cannot read [redacted]'],
    ['double quotes', 'fatal: cannot read "synthetic-one" synthetic-two"', 'fatal: cannot read [redacted]'],
    ['assignment', 'fatal: options example.value=synthetic-one\nfatal: synthetic-two', 'fatal: options example.value=[redacted]'],
    ['URL credentials', 'fatal: could not reach ssh://synthetic-user:synthetic-token@example.invalid', 'fatal: could not reach [redacted]'],
    ['POSIX path', 'fatal: cannot open /synthetic-one/synthetic two', 'fatal: cannot open [redacted]'],
    ['Windows path', 'fatal: cannot open C:\\synthetic-one\\synthetic two', 'fatal: cannot open [redacted]'],
    ['UNC path', 'fatal: cannot open \\\\synthetic-one\\synthetic two', 'fatal: cannot open [redacted]'],
    ['value before a fatal line', "warning: bad input 'synthetic-one'\nfatal: synthetic-two", 'fatal:'],
  ])('redacts %s and preserves the error class', (_label, diagnostic, summary) => {
    let failure: unknown;
    try {
      gitOutput({ status: 128, output: Buffer.alloc(0), diagnostic, truncated: false }, 'Read failed.');
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof DomainError && failure.code).toBe('SOURCE_READ_FAILED');
    expect(failure instanceof DomainError && failure.message === 'Read failed. ' + summary).toBe(true);
  });

  it('prioritizes the fatal class and caps the diagnostic detail', () => {
    const diagnostic = 'warning: ' + 'x'.repeat(2000) + '\nfatal: read failed ' + 'x'.repeat(2000);
    const summary = ('fatal: read failed ' + 'x'.repeat(2000)).slice(0, 1024);
    expect(() => gitOutput({ status: 0, output: Buffer.alloc(0), diagnostic, truncated: false }, 'Read failed.'))
      .toThrowError(new DomainError('SOURCE_READ_FAILED', 'Read failed. ' + summary));
  });

  it('only accepts a full stdout buffer when stderr is below the cap and has no errors', () => {
    const limit = 64;
    const result = { status: 0, output: Buffer.alloc(limit), truncated: true };
    expect(gitReadState({ ...result, diagnostic: 'hint: Git advice\n' }, limit)).toBe('limited');
    expect(gitReadState({ ...result, diagnostic: 'hint: ' + 'x'.repeat(limit - 6) }, limit)).toBe('failed');
    expect(gitReadState({ ...result, diagnostic: 'fatal: read failed' }, limit)).toBe('failed');
  });
});
