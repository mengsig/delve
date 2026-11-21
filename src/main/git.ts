import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DomainError } from '../shared/errors';

/**
 * Checks that `path` is a Git working tree by looking for `.git` (a directory, or a file in
 * worktrees). Reads the filesystem only; never runs git, hooks or project code.
 */
export async function assertGitRepository(path: string): Promise<void> {
  assert.ok(typeof path === 'string', 'path must be a string');
  if (!isAbsolute(path)) throw new DomainError('INVALID_WORKSPACE', 'Choose a repository folder (an absolute path).');
  const folder = await stat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') throw new DomainError('INVALID_WORKSPACE', `${path} does not exist.`, { cause });
    throw cause;
  });
  if (!folder.isDirectory()) throw new DomainError('INVALID_WORKSPACE', `${path} is not a folder.`);
  const marker = await stat(join(path, '.git')).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') throw new DomainError('NOT_A_GIT_REPOSITORY', `${path} is not a Git repository (no .git found).`, { cause });
    throw cause;
  });
  assert.ok(marker.isDirectory() || marker.isFile(), '.git must be a directory or a gitdir file');
}
