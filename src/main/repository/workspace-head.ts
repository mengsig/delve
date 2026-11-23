import assert from 'node:assert/strict';
import type { Workspace } from '../../shared/domain';
import type { WorkspaceHead } from '../../shared/graph';
import { assertGitRepository } from '../git';
import { cachedGithubRepository } from './github-cache';
import { gitReader, resolveCommit } from './git-reader';
import { OBJECT_ID, safeBranch } from './source-policy';
import { completedOutput } from './source-process';

export async function readWorkspaceHead(workspace: Workspace, cacheRoot: string, demo: boolean): Promise<WorkspaceHead> {
  if (demo) return { kind: 'demo' };
  if (workspace.kind === 'topic') return { kind: 'topic' };
  const cached = workspace.kind === 'github';
  const path = cached ? await cachedGithubRepository(cacheRoot, workspace.source) : workspace.source;
  if (!path) return { kind: 'unavailable' };
  if (!cached) await assertGitRepository(path);
  const reader = await gitReader(path);
  const ref = await reader.run(['symbolic-ref', '--quiet', 'HEAD'], 4096);
  if (!ref.truncated && ref.status === 1) {
    const commit = await resolveCommit(reader, 'HEAD');
    assert.ok(OBJECT_ID.test(commit), 'a detached head identifies a commit');
    return { kind: 'detached', commit, cached };
  }
  const name = completedOutput(ref, 'Could not read the repository branch.').toString('utf8').trimEnd();
  if (!name.startsWith('refs/heads/')) return { kind: 'unavailable' };
  const branch = name.slice('refs/heads/'.length);
  if (!safeBranch(branch)) return { kind: 'unavailable' };
  // An unborn local branch is valid. A cached GitHub branch needs its verified commit.
  if (cached) {
    const commit = await resolveCommit(reader, 'HEAD');
    assert.ok(OBJECT_ID.test(commit), 'cached head must identify a commit');
  }
  return { kind: 'branch', branch, cached };
}
