import assert from 'node:assert/strict';
import type { Workspace } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import { assertGitRepository } from '../git';
import { readGitChange } from './git-change';
import { completedOutput } from './source-process';
import { gitReader, listGitChanges, listGitFiles, readGitFiles, type GitChange } from './git-reader';
import { listPullRequests, readPullRequest } from './github';
import { githubRepository, githubSlug } from './github-cache';

export { listGitFiles as listFiles, readGitFiles as readFiles };

export async function repositoryPath(workspace: Workspace, cacheRoot: string): Promise<string> {
  if (workspace.kind === 'github') return githubRepository(cacheRoot, workspace.source);
  if (workspace.kind !== 'git') throw new DomainError('INVALID_WORKSPACE', 'Choose a repository workspace.');
  await assertGitRepository(workspace.source);
  return workspace.source;
}

async function githubSource(path: string | null, workspace: Workspace): Promise<string | null> {
  if (workspace.kind === 'github') return githubSlug(workspace.source);
  assert.ok(path, 'local repository lookup needs its Git directory');
  const reader = await gitReader(path);
  const origin = await reader.run(['config', '--local', '--no-includes', '--get', 'remote.origin.url'], 4096);
  if (origin.status === 1 && !origin.truncated) return null;
  const url = completedOutput(origin, 'Could not read the local repository origin.').toString('utf8').trimEnd();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-z0-9-]+\/[a-z0-9._-]+?)(?:\.git)?\/?$/i.exec(url);
  return match?.[1] ? githubSlug(match[1]) : null;
}

export async function listChanges(path: string, workspace: Workspace): Promise<{ changes: GitChange[]; warning: string | null }> {
  const commits = await listGitChanges(path);
  try {
    const slug = await githubSource(path, workspace);
    if (!slug) return commits;
    const pulls = await listPullRequests(slug);
    return { changes: [...pulls, ...commits.changes], warning: commits.warning };
  } catch (cause) {
    if (cause instanceof DomainError) {
      return { changes: commits.changes, warning: [commits.warning, cause.message].filter(Boolean).join(' ') };
    }
    throw cause;
  }
}

export async function readChange(path: string | null, workspace: Workspace, kind: 'commit' | 'pr', ref: string) {
  if (kind === 'commit') {
    assert.ok(path, 'commit lookup needs a local object database');
    return readGitChange(path, ref);
  }
  const slug = await githubSource(path, workspace);
  if (!slug) throw new DomainError('INVALID_PULL_REQUEST', 'Pull requests require a GitHub repository or a local GitHub origin.');
  return { ...await readPullRequest(slug, ref), repository: slug };
}
