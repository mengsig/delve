import assert from 'node:assert/strict';
import type { ChangeDetail, HistoryRequest } from '../../shared/explorer';
import type { Workspace } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import { assertGitRepository } from '../git';
import { readGitChangeWithPatches, readGitDetail } from './git-change';
import { completedOutput } from './source-process';
import { gitReader, MissingSnapshotCommit, listGitChanges, listGitFiles, readGitFiles, withoutChangePatches, type GitChange } from './git-reader';
import { openGitHistory } from './git-history';
import { readPullHistoryPage, listPullRequests, readPullDetail, readPullRequestWithPatches } from './github';
import { cachedGithubRepository, githubRepository, githubSlug } from './github-cache';

export { listGitFiles as listFiles, readGitFiles as readFiles };

export async function repositoryPath(workspace: Workspace, cacheRoot: string): Promise<string> {
  if (workspace.kind === 'github') return githubRepository(cacheRoot, workspace.source);
  if (workspace.kind !== 'git') throw new DomainError('INVALID_WORKSPACE', 'Choose a repository workspace.');
  await assertGitRepository(workspace.source);
  return workspace.source;
}

export async function repositorySnapshotPath(workspace: Workspace, cacheRoot: string, initialize = true): Promise<string> {
  if (workspace.kind !== 'github') return repositoryPath(workspace, cacheRoot);
  const path = await cachedGithubRepository(cacheRoot, workspace.source);
  if (!path && initialize) return githubRepository(cacheRoot, workspace.source);
  if (!path) throw new DomainError('GITHUB_CACHE_MISSING', 'There is no local snapshot of this repository.');
  return path;
}

export async function withCommitSnapshot<T>(workspace: Workspace, cacheRoot: string, read: (path: string) => Promise<T>): Promise<T> {
  if (workspace.kind !== 'github') return read(await repositoryPath(workspace, cacheRoot));
  const cached = await cachedGithubRepository(cacheRoot, workspace.source);
  if (cached) {
    try { return await read(cached); }
    catch (cause) { if (!(cause instanceof MissingSnapshotCommit)) throw cause; }
  }
  // The linked revision may have been pushed since the last shallow snapshot.
  return read(await githubRepository(cacheRoot, workspace.source));
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

async function pullSource(path: string | null, workspace: Workspace): Promise<string> {
  const slug = await githubSource(path, workspace);
  if (!slug) throw new DomainError('INVALID_PULL_REQUEST', 'Pull requests require a GitHub repository or a local GitHub origin.');
  assert.equal(slug, githubSlug(slug));
  return slug;
}

export async function readChangeWithPatches(path: string | null, workspace: Workspace, kind: 'commit' | 'pr', ref: string) {
  if (kind === 'commit') {
    assert.ok(path, 'commit lookup needs a local object database');
    return readGitChangeWithPatches(path, ref);
  }
  const slug = await pullSource(path, workspace);
  return { ...await readPullRequestWithPatches(slug, ref), repository: slug };
}

export async function readChange(path: string | null, workspace: Workspace, kind: 'commit' | 'pr', ref: string) {
  return withoutChangePatches(await readChangeWithPatches(path, workspace, kind, ref));
}

export async function readChangeDetail(path: string | null, workspace: Workspace, kind: 'commit' | 'pr', ref: string): Promise<ChangeDetail> {
  if (kind === 'commit') {
    assert.ok(path, 'commit lookup needs a local object database');
    return readGitDetail(path, ref);
  }
  return readPullDetail(await pullSource(path, workspace), ref);
}

async function historySnapshot(workspace: Workspace, cacheRoot: string, request: HistoryRequest) {
  if (workspace.kind === 'github' && request.refreshSnapshot && request.kind !== 'pr') {
    try { return { path: await githubRepository(cacheRoot, workspace.source) }; }
    catch (cause) {
      if (!(cause instanceof DomainError)) throw cause;
      const cached = await cachedGithubRepository(cacheRoot, workspace.source);
      if (!cached) throw cause;
      return { path: cached, warning: cause.message + ' Showing the last local snapshot.' };
    }
  }
  return { path: await repositorySnapshotPath(workspace, cacheRoot, request.kind !== 'pr') };
}

export async function gitHistory(workspace: Workspace, cacheRoot: string, request: HistoryRequest) {
  assert.equal(workspace.id, request.workspaceId);
  assert.ok(workspace.kind === 'git' || workspace.kind === 'github');
  try {
    const { path, warning } = await historySnapshot(workspace, cacheRoot, request);
    const history = await openGitHistory(path, request.branch, request.kind !== 'pr');
    if (warning) history.warnings.push(warning);
    return history;
  } catch (cause) {
    if (!(cause instanceof DomainError)) throw cause;
    const warnings = request.kind === 'pr' && cause.code === 'GITHUB_CACHE_MISSING' ? [] : [cause.message];
    return { branches: [], warnings, read: null };
  }
}

export async function pullHistory(workspace: Workspace, commitsOnly: boolean) {
  assert.ok(workspace.kind === 'git' || workspace.kind === 'github');
  try {
    const slug = await githubSource(workspace.kind === 'git' ? workspace.source : null, workspace);
    if (!slug) return { status: 'local' as const, read: null, warning: null };
    const read = commitsOnly ? null : (page: number) => readPullHistoryPage(slug, page);
    return { status: 'unchecked' as const, read, warning: null };
  } catch (cause) {
    if (!(cause instanceof DomainError)) throw cause;
    return { status: 'unavailable' as const, read: null, warning: cause.message };
  }
}
