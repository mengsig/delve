import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertGitRepository } from './git';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delve-git-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('assertGitRepository', () => {
  it('accepts a folder with a .git directory or a worktree .git file', async () => {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    await expect(assertGitRepository(join(dir, 'repo'))).resolves.toBeUndefined();
    mkdirSync(join(dir, 'worktree'));
    writeFileSync(join(dir, 'worktree', '.git'), 'gitdir: /elsewhere\n');
    await expect(assertGitRepository(join(dir, 'worktree'))).resolves.toBeUndefined();
  });

  it('rejects missing folders, files, plain folders and relative paths with clear codes', async () => {
    await expect(assertGitRepository(join(dir, 'missing'))).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' });
    writeFileSync(join(dir, 'file.txt'), 'x');
    await expect(assertGitRepository(join(dir, 'file.txt'))).rejects.toThrow(/not a folder/);
    await expect(assertGitRepository(dir)).rejects.toMatchObject({ code: 'NOT_A_GIT_REPOSITORY' });
    await expect(assertGitRepository('relative')).rejects.toThrow(/absolute path/);
  });
});
