import { beforeEach, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/domain';
import { assertGitRepository } from '../git';
import { cachedGithubRepository } from './github-cache';
import { gitReader, resolveCommit } from './git-reader';
import { readWorkspaceHead } from './workspace-head';

vi.mock('../git', () => ({ assertGitRepository: vi.fn() }));
vi.mock('./github-cache', () => ({ cachedGithubRepository: vi.fn() }));
vi.mock('./git-reader', () => ({ gitReader: vi.fn(), resolveCommit: vi.fn() }));

const workspace = { id: 'workspace', name: 'Repo', kind: 'git', source: '/work/repo', createdAt: '', lastOpenedAt: null } satisfies Workspace;
const run = vi.fn<Awaited<ReturnType<typeof gitReader>>['run']>();
const commit = 'a'.repeat(40);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(gitReader).mockResolvedValue({ run });
  vi.mocked(resolveCommit).mockResolvedValue(commit);
});

it('reads the symbolic branch of a local checkout and the commit for a detached HEAD', async () => {
  run.mockResolvedValueOnce({ status: 0, truncated: false, output: Buffer.from('refs/heads/feature/shell\n'), diagnostic: '' });
  expect(await readWorkspaceHead(workspace, '/cache', false)).toEqual({ kind: 'branch', branch: 'feature/shell', cached: false });
  expect(assertGitRepository).toHaveBeenCalledWith(workspace.source);
  expect(resolveCommit).not.toHaveBeenCalled();
  run.mockResolvedValueOnce({ status: 1, truncated: false, output: Buffer.alloc(0), diagnostic: '' });
  expect(await readWorkspaceHead(workspace, '/cache', false)).toEqual({ kind: 'detached', commit, cached: false });
  expect(resolveCommit).toHaveBeenCalledWith({ run }, 'HEAD');
});

it('uses only a verified cached GitHub head and handles non-repository contexts', async () => {
  const github = { ...workspace, kind: 'github', source: 'owner/repo' } as const;
  vi.mocked(cachedGithubRepository).mockResolvedValueOnce(null).mockResolvedValueOnce('/cache/repo.git');
  expect(await readWorkspaceHead(github, '/cache', false)).toEqual({ kind: 'unavailable' });
  expect(gitReader).not.toHaveBeenCalled();
  run.mockResolvedValueOnce({ status: 0, truncated: false, output: Buffer.from('refs/heads/main\n'), diagnostic: '' });
  expect(await readWorkspaceHead(github, '/cache', false)).toEqual({ kind: 'branch', branch: 'main', cached: true });
  expect(gitReader).toHaveBeenCalledWith('/cache/repo.git');
  expect(resolveCommit).toHaveBeenCalledOnce();
  expect(await readWorkspaceHead(github, '/cache', true)).toEqual({ kind: 'demo' });
  expect(await readWorkspaceHead({ ...workspace, kind: 'topic' }, '/cache', false)).toEqual({ kind: 'topic' });
});
