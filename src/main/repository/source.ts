import type { Workspace } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import { assertGitRepository } from '../git';
import { readGitChange } from './git-change';
import { listGitChanges, listGitFiles, readGitFiles, type GitChange } from './git-reader';
import { listPullRequests, readPullRequest } from './github';
import { githubRepository } from './github-cache';

export { listGitFiles as listFiles, readGitFiles as readFiles };

export async function repositoryPath(workspace: Workspace, cacheRoot: string): Promise<string> {
  if (workspace.kind === 'github') return githubRepository(cacheRoot, workspace.source);
  if (workspace.kind !== 'git') throw new DomainError('INVALID_WORKSPACE', 'Choose a repository workspace.');
  await assertGitRepository(workspace.source);
  return workspace.source;
}

export async function listChanges(path: string, workspace: Workspace): Promise<{ changes: GitChange[]; warning: string | null }> {
  const commits = await listGitChanges(path);
  if (workspace.kind !== 'github') return commits;
  try {
    const pulls = await listPullRequests(workspace.source);
    return { changes: [...pulls, ...commits.changes], warning: commits.warning };
  } catch (cause) {
    if (cause instanceof DomainError) {
      return { changes: commits.changes, warning: [commits.warning, cause.message].filter(Boolean).join(' ') };
    }
    throw cause;
  }
}

export async function readChange(path: string, workspace: Workspace, kind: 'commit' | 'pr', ref: string) {
  if (kind === 'commit') return readGitChange(path, ref);
  if (workspace.kind !== 'github') throw new DomainError('INVALID_PULL_REQUEST', 'Pull requests require a GitHub repository workspace.');
  return readPullRequest(workspace.source, ref);
}
