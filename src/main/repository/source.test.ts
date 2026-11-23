import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/connection';
import { addWorkspace } from '../db/workspaces';
import { ProviderRunner } from '../providers/runner';
import { RepositoryLearning } from './service';
import type { Workspace } from '../../shared/domain';
import { openRepositoryHistory } from './history';
import { listChanges, listFiles, readChange, readChangeDetail, readChangeWithPatches, readFiles, repositoryPath } from './source';
import * as sourceProcess from './source-process';

let root: string;
let repo: string;
let workspace: Workspace;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(title: string, ...args: string[]): string {
  git('add', '--all');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', title, ...args);
  return git('rev-parse', 'HEAD');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'delve-source-test-'));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '--quiet', '--template=', '--initial-branch=main', repo]);
  git('config', 'user.name', 'Fixture User');
  git('config', 'user.email', 'fixture@example.invalid');
  workspace = { id: 'fixture', name: 'Fixture', kind: 'git', source: repo, createdAt: '', lastOpenedAt: null };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('Git snapshots', () => {
  it('pins reads to a commit and ignores working-tree content and Git environment overrides', async () => {
    await writeFile(join(repo, 'main.ts'), 'export const answer = 1;\n');
    const first = commit('First');
    const original = await listFiles(await repositoryPath(workspace, root));
    expect(original).toEqual({ commit: first, files: [{ path: 'main.ts', bytes: 25 }], partial: false });
    await writeFile(join(repo, 'main.ts'), 'export const answer = 2;\n');
    const second = commit('Second');
    await writeFile(join(repo, 'main.ts'), 'uncommitted');
    await writeFile(join(repo, 'untracked.ts'), 'untracked');
    vi.stubEnv('GIT_DIR', join(root, 'missing'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    expect(await listFiles(repo)).toEqual({ commit: second, files: original.files, partial: false });
    expect(await readFiles(repo, first, ['main.ts', 'untracked.ts'])).toEqual([{ path: 'main.ts', text: 'export const answer = 1;\n' }]);
  });

  it('excludes secret paths, non-text contents and oversized blobs', async () => {
    await writeFile(join(repo, 'safe.ts'), 'ok');
    await writeFile(join(repo, '.env.production'), 'VALUE=sentinel');
    await writeFile(join(repo, 'large.txt'), Buffer.alloc(128 * 1024 + 1, 'x'));
    await writeFile(join(repo, 'binary.txt'), Buffer.from([0, 255]));
    await writeFile(join(repo, 'invalid-utf8.txt'), Buffer.from([255]));
    await writeFile(join(repo, 'private.txt'), '-----BEGIN PRIVATE KEY-----');
    const head = commit('Mixed');
    const listed = await listFiles(repo);
    expect(listed.partial).toBe(true);
    expect(listed.files.map(f => f.path)).toEqual(['binary.txt', 'invalid-utf8.txt', 'private.txt', 'safe.ts']);
    expect(await readFiles(repo, head, ['safe.ts', '.env.production', 'large.txt', 'binary.txt', 'invalid-utf8.txt', 'private.txt', '../outside'])).toEqual([
      { path: 'safe.ts', text: 'ok' },
    ]);
  });

  it('reads nested selections as literal paths and excludes unavailable partial-clone blobs', async () => {
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', '[main].ts'), 'safe\n');
    await writeFile(join(repo, 'large.txt'), Buffer.alloc(128 * 1024 + 1, 'x'));
    const head = commit('Baseline');
    const clone = join(root, 'promisor.git');
    git('config', 'uploadpack.allowFilter', 'true');
    git('clone', '--bare', '--no-local', '--filter=blob:limit=131073', repo, clone);
    expect(await listFiles(clone)).toEqual({ commit: head, partial: true, files: [{ path: 'src/[main].ts', bytes: 5 }] });
    expect(await readFiles(clone, head, ['large.txt', 'src/[main].ts'])).toEqual([{ path: 'src/[main].ts', text: 'safe\n' }]);
    expect(await readChange(clone, workspace, 'commit', head)).toMatchObject({ partial: true, files: ['src/[main].ts'] });
  });

  it.skipIf(process.platform === 'win32')('supports linked worktrees without reading through symlinks', async () => {
    await writeFile(join(repo, 'base.txt'), 'base\n');
    const head = commit('Base');
    const linked = join(root, 'linked');
    git('worktree', 'add', '--detach', linked, head);
    await symlink(join(root, 'outside'), join(repo, 'link'));
    await writeFile(join(root, 'outside'), 'sensitive data');
    const linkCommit = commit('Symlink');
    expect(await listFiles(await repositoryPath({ ...workspace, source: linked }, root))).toMatchObject({ commit: head, partial: false });
    expect(await listFiles(repo)).toMatchObject({ commit: linkCommit, partial: true });
    expect(await readFiles(repo, linkCommit, ['link'])).toEqual([]);
    expect(await readChange(repo, workspace, 'commit', linkCommit)).toMatchObject({ partial: true, files: [], diff: '' });
  });
});

describe('Git changes', () => {
  it('reads full and abbreviated commit IDs while skipping excluded file patches', async () => {
    await writeFile(join(repo, 'main.ts'), 'old\n');
    const initial = commit('Baseline');
    await writeFile(join(repo, 'main.ts'), 'new\n');
    await writeFile(join(repo, '.env'), 'PRIVATE=sentinel');
    const second = commit('Update logic');
    const history = await listChanges(repo, workspace);
    expect(history).toEqual({ changes: [
      { kind: 'commit', ref: second, title: 'Update logic' },
      { kind: 'commit', ref: initial, title: 'Baseline' },
    ], warning: null });
    const rootChange = await readChange(repo, workspace, 'commit', initial);
    expect(rootChange).toMatchObject({ partial: false, files: ['main.ts'] });
    expect(rootChange.diff).toContain('+old');
    const change = await readChange(repo, workspace, 'commit', second.slice(0, 8));
    expect(change).toMatchObject({ commit: second, title: 'Update logic', partial: true, files: ['main.ts'] });
    expect(change.diff).toContain('-old\n+new');
    expect(change.diff).not.toContain('sentinel');
  });

  it('passes the Git null file to every diff-tree call and ignores repository diff ordering', async () => {
    await writeFile(join(repo, 'a.txt'), 'first\n');
    await writeFile(join(repo, 'z.txt'), 'last\n');
    const head = commit('Add files');
    await writeFile(join(root, 'order'), 'z.txt\na.txt\n');
    git('config', 'diff.orderFile', join(root, 'order'));
    expect(git('show', '--format=', '--name-only', head).split(/\r?\n/)).toEqual(['z.txt', 'a.txt']);

    const gitSource = vi.spyOn(sourceProcess, 'gitSource');
    try {
      const detail = await readChangeDetail(repo, workspace, 'commit', head);
      expect(detail).toMatchObject({ fileCount: 2, additions: 2, deletions: 0, partial: false });
      expect(detail.files.map(file => file.path)).toEqual(['a.txt', 'z.txt']);
      const diffCalls = gitSource.mock.calls.map(([args]) => args).filter(args => args.includes('diff-tree'));
      expect(diffCalls).toHaveLength(4);
      for (const args of diffCalls) {
        const order = args.indexOf('-O');
        expect(order).toBeGreaterThan(-1);
        expect(args[order + 1]).toBe('/dev/null');
      }
    } finally {
      gitSource.mockRestore();
    }
  });
});

describe('Git change read boundaries', () => {
  it.skipIf(process.platform === 'win32')('disables executable Git diff and text conversion configuration', async () => {
    await writeFile(join(repo, 'source.txt'), 'old\n');
    await writeFile(join(repo, '.gitattributes'), '*.txt diff=custom\n');
    commit('Baseline');
    await writeFile(join(repo, 'source.txt'), 'updated\n');
    const head = commit('Change');
    const sentinel = join(root, 'ran-command');
    const executable = join(root, 'command');
    await writeFile(executable, `#!/bin/sh\n: > "${sentinel}"\n`, { mode: 0o700 });
    git('config', 'diff.external', executable);
    git('config', 'diff.custom.command', executable);
    git('config', 'diff.custom.textconv', executable);
    git('config', 'core.fsmonitor', executable);
    await mkdir(join(repo, '.git', 'info'));
    await writeFile(join(repo, '.git', 'info', 'attributes'), '*.txt diff=custom\n');
    const change = await readChange(repo, workspace, 'commit', head);
    expect(change.diff).toContain('+updated');
    await expect(stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns partial coverage at a shallow history boundary', async () => {
    await writeFile(join(repo, 'main.ts'), 'old\n');
    const base = commit('Baseline');
    await writeFile(join(repo, 'main.ts'), 'new\n');
    const head = commit('Change');
    const shallow = join(root, 'shallow.git');
    git('clone', '--bare', '--depth=1', '--no-local', repo, shallow);
    expect(await readChange(shallow, workspace, 'commit', head)).toMatchObject({
      commit: head, title: 'Change', diff: '', files: [], partial: true,
    });
    expect(await readChangeDetail(shallow, workspace, 'commit', head)).toMatchObject({
      node: { ref: head, parents: [base] }, base, partial: true, statsCoverage: 'unavailable', files: [],
    });
  });

  it('omits binary and oversized patches while keeping complete text patches', async () => {
    await writeFile(join(repo, 'huge.txt'), Buffer.alloc(65 * 1024, 'x'));
    await writeFile(join(repo, 'binary.png'), Buffer.from([0, 255]));
    await writeFile(join(repo, 'source.txt'), 'small\n');
    const head = commit('Mixed patch');
    const snapshot = await readChange(repo, workspace, 'commit', head);
    expect(snapshot).toMatchObject({ partial: true, files: ['source.txt'] });
    expect(snapshot.diff).toContain('+small');
    expect(snapshot.diff).not.toContain('huge.txt');
  });

  it('rejects revision syntax and unreachable commit objects', async () => {
    await writeFile(join(repo, 'source.txt'), 'safe\n');
    const head = commit('Baseline');
    await writeFile(join(repo, 'source.txt'), 'dangling\n');
    const dangling = commit('Dangling');
    git('reset', '--hard', head);
    await expect(readChange(repo, workspace, 'commit', 'HEAD~1')).rejects.toMatchObject({ code: 'INVALID_COMMIT' });
    await expect(readChange(repo, workspace, 'commit', dangling)).rejects.toMatchObject({ code: 'INVALID_COMMIT' });
  });
});

  it.each([{ count: 'one parent', missingIds: ['a'] }, { count: 'two parents', missingIds: ['a', 'b'] }])(
    'keeps readable commits in order when a merge is missing $count', async ({ missingIds }) => {
      const base = commit('Base', '--allow-empty');
      const tree = git('rev-parse', `${base}^{tree}`);
      const missing = missingIds.map(char => char.repeat(40));
      git('update-ref', 'refs/heads/intact', base);
      const parents = [...missing, base];
      const object = `tree ${tree}\n${parents.map(parent => `parent ${parent}\n`).join('')}author Fixture User <fixture@example.invalid> 1700000000 +0000\n`
        + 'committer Fixture User <fixture@example.invalid> 1700000000 +0000\n\nBoundary\n';
      const boundary = execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'],
        { input: object, encoding: 'utf8' }).trim();
      git('update-ref', 'refs/heads/main', boundary);
      const expected = [boundary, base];
      for (let i = 0; i < 35; i++) expected.unshift(commit(`Readable ${i}`, '--allow-empty'));
      const history = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
      const pages = [];
      let next: number | null = 0;
      while (next !== null && pages.length < 5) {
        const page = await history.advance(() => pages.length + 1);
        pages.push(page);
        next = page.next;
      }
      expect(next).toBeNull();
      expect(pages.flatMap(page => page.nodes.map(node => node.ref))).toEqual(expected);
      expect(pages.flatMap(page => page.nodes).find(node => node.ref === boundary)?.parents).toEqual(parents);
      expect(pages.at(-1)?.warning).toContain(missing[0]);
      expect(pages.at(-1)?.warning).toContain('git fsck');
    }, 30_000);

  it('keeps commits from other branches that are not behind the missing parent', async () => {
    const root0 = commit('Root', '--allow-empty');
    git('switch', '-c', 'other');
    for (let i = 0; i < 3; i++) commit(`Other ${i}`, '--allow-empty', '--date=2019-01-01T00:00:00+00:00');
    git('switch', 'main');
    const tree = git('rev-parse', `${root0}^{tree}`);
    const missing = 'c'.repeat(40);
    const object = `tree ${tree}\nparent ${missing}\nauthor Fixture User <fixture@example.invalid> 1700000000 +0000\n`
      + 'committer Fixture User <fixture@example.invalid> 1700000000 +0000\n\nBroken tip\n';
    const broken = execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'],
      { input: object, encoding: 'utf8' }).trim();
    git('update-ref', 'refs/heads/main', broken);
    const expected = new Set([broken, root0, ...git('log', '--format=%H', 'other').split('\n')]);
    const history = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
    const pages = [];
    let next: number | null = 0;
    while (next !== null && pages.length < 5) {
      const page = await history.advance(() => pages.length + 1);
      pages.push(page);
      next = page.next;
    }
    const refs = pages.flatMap(page => page.nodes.map(node => node.ref));
    expect(new Set(refs)).toEqual(expected);
    expect(refs).toHaveLength(expected.size);
    expect(pages.at(-1)?.warning).toContain(missing);
  }, 30_000);

  it('reports a Git log configuration failure instead of marking healthy tips as damaged', async () => {
    const base = commit('Base', '--allow-empty');
    git('branch', 'other', base);
    commit('Healthy tip', '--allow-empty');
    git('config', 'log.abbrevCommit', 'invalid');

    await expect(openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []))
      .rejects.toMatchObject({ code: 'SOURCE_READ_FAILED', message: expect.stringMatching(/bad boolean config value.*log\.abbrevcommit/i) });
  });

  it('fails with the Git diagnostic when configuration breaks after the tip probe', async () => {
    commit('Healthy tip', '--allow-empty');
    const history = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
    git('config', 'log.abbrevCommit', 'invalid');

    await expect(history.advance(() => 1)).rejects.toMatchObject({
      code: 'SOURCE_READ_FAILED', message: expect.stringMatching(/bad boolean config value.*log\.abbrevcommit/i),
    });
  });

  it('does not recover from a bad-object diagnostic when the named commit is readable', async () => {
    const head = commit('Healthy tip', '--allow-empty');
    const { gitSource } = sourceProcess;
    const diagnostic = 'fatal: bad object ' + head;
    const spy = vi.spyOn(sourceProcess, 'gitSource').mockImplementation((args, options) => args.includes('--author-date-order')
      ? Promise.resolve({ status: 128, truncated: false, output: Buffer.alloc(0), diagnostic })
      : gitSource(args, options));
    try {
      const history = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
      await expect(history.advance(() => 1)).rejects.toMatchObject({
        code: 'SOURCE_READ_FAILED', message: 'Could not read Git history. ' + diagnostic,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it.each([0, 128])('fails on a fatal diagnostic after repairing a missing parent (status %i)', async status => {
    const missing = commit('Removed parent', '--allow-empty');
    const boundary = commit('Readable boundary', '--allow-empty');
    await rm(join(repo, '.git', 'objects', missing.slice(0, 2), missing.slice(2)));
    const { gitSource } = sourceProcess;
    const spy = vi.spyOn(sourceProcess, 'gitSource').mockImplementation(async (args, options) => {
      const result = await gitSource(args, options);
      if (!args.includes('--author-date-order') || !options?.graftFile) return result;
      expect(result.status).toBe(0);
      expect(result.output.toString()).toContain(boundary);
      return { ...result, status, diagnostic: 'fatal: synthetic filesystem\u200bfailure' };
    });
    try {
      const history = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
      await expect(history.advance(() => 1)).rejects.toMatchObject({
        code: 'SOURCE_READ_FAILED', message: 'Could not read Git history. fatal: synthetic filesystem failure',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('fails with a read limit even when the walk captured a complete commit', async () => {
    const head = commit('Healthy tip', '--allow-empty');
    const { gitSource } = sourceProcess;
    const spy = vi.spyOn(sourceProcess, 'gitSource').mockImplementation(async (args, options) => {
      const result = await gitSource(args, options);
      if (!args.includes('--author-date-order')) return result;
      expect(result.output.toString()).toContain(head);
      return { ...result, truncated: true, diagnostic: 'error: diagnostic from the limited walk' };
    });
    try {
      const history = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
      await expect(history.advance(() => 1)).rejects.toMatchObject({
        code: 'SOURCE_READ_FAILED',
        message: 'Git history output exceeded the read limit. error: diagnostic from the limited walk',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a tip probe output limit even when Git emits a corrupt-object diagnostic', async () => {
    const head = commit('Healthy tip', '--allow-empty');
    const { gitSource } = sourceProcess;
    const spy = vi.spyOn(sourceProcess, 'gitSource').mockImplementation((args, options) => args.includes('--ignore-missing')
      ? Promise.resolve({ status: 0, truncated: true, output: Buffer.alloc(0),
        diagnostic: `fatal: loose object ${head} (stored in .git/objects/file) is corrupt` })
      : gitSource(args, options));
    try {
      await expect(openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []))
        .rejects.toMatchObject({ code: 'SOURCE_READ_FAILED',
          message: expect.stringMatching(/^Git history output exceeded the read limit\. fatal: loose object/) });
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['missing', 'malformed'])('keeps healthy branches when a branch tip is %s', async kind => {
    const base = commit('Base', '--allow-empty');
    const head = commit('Healthy tip', '--allow-empty');
    const damaged = kind === 'malformed'
      ? execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--literally', '--stdin'],
        { input: 'invalid commit\n', encoding: 'utf8' }).trim()
      : 'a'.repeat(head.length);
    await writeFile(join(repo, '.git', 'refs', 'heads', 'broken'), damaged + '\n');
    const request = { workspaceId: workspace.id, cursor: 0, kind: 'commit' } as const;
    const history = await openRepositoryHistory(workspace, root, request, []);
    const page = await history.advance(() => 1);
    expect(page.nodes.map(node => node.ref)).toEqual([head, base]);
    expect(page.next).toBeNull();
    expect(page.warning).toContain(damaged);

    const filtered = await openRepositoryHistory(workspace, root, { ...request, branch: 'broken' }, []);
    const filteredPage = await filtered.advance(() => 1);
    expect(filteredPage.nodes).toEqual([]);
    expect(filteredPage.next).toBeNull();
    expect(filteredPage.warning).toContain(damaged);
  });

  it('retries a corrupt loose tip by removing only the object named by Git', async () => {
    const base = commit('Base', '--allow-empty');
    git('switch', '-c', 'other');
    const other = commit('Healthy other tip', '--allow-empty');
    git('switch', 'main');
    const head = commit('Healthy main tip', '--allow-empty');
    const damaged = 'a'.repeat(head.length);
    const directory = join(repo, '.git', 'objects', damaged.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, damaged.slice(2)), Buffer.from([255, 255, 255, 255]));
    await writeFile(join(repo, '.git', 'refs', 'heads', 'broken'), damaged + '\n');

    const { gitSource } = sourceProcess;
    const spy = vi.spyOn(sourceProcess, 'gitSource');
    try {
      const history = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
      const page = await history.advance(() => 1);
      expect(page.nodes.map(node => node.ref).sort()).toEqual([head, other, base].sort());
      expect(page.warning).toBe(`Git commit ${damaged} is missing or damaged. Run git fsck to check the repository. You may need to restore the commit from a healthy copy.`);
      const probes = spy.mock.calls.map(([args]) => args).filter(args => args.includes('--ignore-missing'));
      expect(probes.map(args => args.slice(args.indexOf('--ignore-missing') + 1, -1))).toEqual([[damaged, head, other], [head, other]]);
      expect(spy.mock.calls.some(([args]) => args.includes('rev-list') && args.at(-2) === damaged)).toBe(true);

      const filtered = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit', branch: 'broken' }, []);
      expect(await filtered.advance(() => 1)).toMatchObject({ nodes: [], next: null, warning: page.warning });

      spy.mockImplementation((args, options) => args.includes('--ignore-missing') && !args.includes(damaged)
        ? Promise.resolve({ status: 128, truncated: false, output: Buffer.alloc(0), diagnostic: 'fatal: failed to read workspace settings' })
        : gitSource(args, options));
      await expect(openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []))
        .rejects.toMatchObject({ code: 'SOURCE_READ_FAILED', message: 'Could not read Git history. fatal: failed to read workspace settings' });
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a missing detached HEAD and keeps branch history', async () => {
    const head = commit('Healthy tip', '--allow-empty');
    const missing = 'e'.repeat(head.length);
    await writeFile(join(repo, '.git', 'HEAD'), missing + '\n');
    const history = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
    const page = await history.advance(() => 1);
    expect(page.nodes.map(node => node.ref)).toEqual([head]);
    expect(page.warning).toContain(missing);
  });

  it('fails on a real output limit after repairing a missing-parent merge', async () => {
    let parent = commit('Oldest', '--allow-empty');
    const tree = git('rev-parse', `${parent}^{tree}`);
    for (let i = 0; i < 4; i++) {
      const object = `tree ${tree}\nparent ${parent}\nauthor Fixture User <fixture@example.invalid> 1700000000 +0000\n`
        + `committer Fixture User <fixture@example.invalid> 1700000000 +0000\n\nLarge ${i} ${'x'.repeat(800 * 1024)}\n`;
      parent = execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'],
        { input: object, encoding: 'utf8' }).trim();
    }
    const missing = 'd'.repeat(40);
    const object = `tree ${tree}\nparent ${missing}\nparent ${parent}\nauthor Fixture User <fixture@example.invalid> 1700000000 +0000\n`
      + 'committer Fixture User <fixture@example.invalid> 1700000000 +0000\n\nBoundary\n';
    const boundary = execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'],
      { input: object, encoding: 'utf8' }).trim();
    git('update-ref', 'refs/heads/main', boundary);
    const history = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
    await expect(history.advance(() => 1)).rejects.toMatchObject({
      code: 'SOURCE_READ_FAILED', message: expect.stringMatching(/^Git history output exceeded the read limit\./),
    });
  }, 30_000);

  it('keeps available shallow commits and explains how to fetch older history', async () => {
    commit('Older', '--allow-empty');
    const middle = commit('Middle', '--allow-empty');
    const head = commit('Head', '--allow-empty');
    const shallow = join(root, 'shallow-history.git');
    git('clone', '--depth=2', '--no-local', repo, shallow);
    const shallowWorkspace = { ...workspace, source: shallow };
    const history = await openRepositoryHistory(shallowWorkspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
    const page = await history.advance(() => 1);
    expect(page.nodes.map(node => node.ref)).toEqual([head, middle]);
    expect(page.next).toBeNull();
    expect(page.warning).toContain('shallow');
    expect(page.warning).toContain('git fetch --unshallow');
  });

describe('repository explorer metadata limits', () => {
  it('fails when the first commit exceeds the output limit', async () => {
    commit('Older commit', '--allow-empty');
    await writeFile(join(root, 'message'), 'x'.repeat(2 * 1024 * 1024 + 1024));
    git('commit', '--quiet', '--allow-empty', '-F', join(root, 'message'));
    const history = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
    await expect(history.advance(() => 1)).rejects.toMatchObject({
      code: 'SOURCE_READ_FAILED', message: expect.stringMatching(/^Git history output exceeded the read limit\./),
    });
  });

  it('reports the limit as a failure on subsequent pages too', async () => {
    commit('Older commit', '--allow-empty');
    await writeFile(join(root, 'message'), 'x'.repeat(2 * 1024 * 1024 + 1024));
    git('commit', '--quiet', '--allow-empty', '-F', join(root, 'message'));
    for (let i = 0; i < 35; i++) commit(`Readable ${i}`, '--allow-empty');
    const expected = git('log', '--format=%H', '--max-count=30').split('\n');
    const history = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
    const first = await history.advance(() => 1);
    expect(first.nodes.map(node => node.ref)).toEqual(expected);
    expect(first.next).toBe(1);
    await expect(history.advance(() => 2)).rejects.toMatchObject({
      code: 'SOURCE_READ_FAILED', message: expect.stringMatching(/^Git history output exceeded the read limit\./),
    });
  }, 30_000);

});

describe('repository explorer', () => {
  it('uses full non-HEAD branch ancestry and filters rows before paging', async () => {
    await writeFile(join(repo, 'shared.txt'), 'shared\n');
    const base = commit('Shared ancestor', '--date=2020-03-01T10:11:12+04:00');
    git('switch', '-c', 'feature');
    const oldFeature = commit('Earlier feature', '--allow-empty', '--date=2020-03-02T10:11:12+04:00');
    for (let i = 0; i < 32; i++) {
      commit(`Feature step ${i}`, '--allow-empty', '--date=2020-03-03T10:11:12+04:00');
    }
    const featureTip = git('rev-parse', 'HEAD');
    git('switch', 'main');
    const mainTip = commit('Main only', '--allow-empty', '--date=2020-03-04T10:11:12+04:00');
    const request = { workspaceId: workspace.id, cursor: 0, branch: 'feature', author: 'fixture user' };
    const history = await openRepositoryHistory(workspace, root, request, []);
    const first = await history.advance(() => 30);
    expect(first).toMatchObject({ branches: ['feature', 'main'], next: 30, warning: null, pullStatus: 'local' });
    expect(first.nodes[0]).toMatchObject({ ref: featureTip, branches: ['feature'] });
    const second = await history.advance(() => 60);
    expect(second.next).toBeNull();
    expect(second.nodes.map(node => node.ref)).toContain(oldFeature);
    expect(second.nodes.map(node => node.ref)).not.toContain(mainTip);
    expect(second.nodes.at(-1)).toMatchObject({ ref: base, title: 'Shared ancestor', date: '2020-03-01T10:11:12+04:00',
      author: 'Fixture User', parents: [], branches: [] });
    const search = await openRepositoryHistory(workspace, root, { ...request, author: 'fixture', search: 'Earlier feature' }, []);
    expect(await search.advance(() => 1)).toMatchObject({ nodes: [], next: 1 });
    expect(await search.advance(() => 2)).toMatchObject({ nodes: [{ ref: oldFeature }], next: null });
  }, 30_000);

  it('pins refs across lazy pages and makes each continuation idempotent and query-scoped', async () => {
    const old = commit('Root', '--allow-empty');
    for (let i = 0; i < 35; i++) commit(`Step ${i}`, '--allow-empty');
    const pinned = git('log', '--format=%H').split('\n');
    const db = openDatabase(':memory:');
    const runner = new ProviderRunner({ resolveProvider: async () => { throw new Error('Unexpected provider call'); } });
    const learning = new RepositoryLearning(db, root, runner);
    try {
      const { id } = addWorkspace(db, { kind: 'git', path: repo });
      const request = { workspaceId: id, cursor: 0, branch: 'main' };
      const first = await learning.history(request);
      expect(first.nodes.map(node => node.ref)).toEqual(pinned.slice(0, 30));
      git('reset', '--hard', old);
      const newTip = commit('Fresh branch history', '--allow-empty');
      const refreshed = await learning.history(request);
      expect(refreshed.nodes.map(node => node.ref)).toEqual([newTip, old]);
      const continuation = { ...request, cursor: first.next! };
      await expect(learning.history({ ...continuation, search: 'other' })).rejects.toMatchObject({ code: 'STALE_HISTORY' });
      git('config', 'log.abbrevCommit', 'invalid');
      await expect(learning.history(continuation)).rejects.toMatchObject({ code: 'SOURCE_READ_FAILED' });
      git('config', '--unset', 'log.abbrevCommit');
      const [second, retried] = await Promise.all([learning.history(continuation), learning.history(continuation)]);
      expect(second).toEqual(retried);
      expect(second.nodes.map(node => node.ref)).toEqual(pinned.slice(30));
      expect(second.next).toBeNull();
    } finally {
      await learning.close();
      db.close();
    }
  }, 30_000);

});

describe('explorer detail and offline history', () => {
  it('keeps exact change totals and exposes unavailable patches without private paths', async () => {
    await writeFile(join(repo, 'main.txt'), 'before\n');
    const base = commit('Base');
    await writeFile(join(repo, 'main.txt'), 'after\nextra\n');
    await writeFile(join(repo, '.env'), 'PRIVATE=sentinel\n');
    await writeFile(join(repo, 'binary.png'), Buffer.from([0, 255]));
    const ref = commit('Change');
    const details = await readChangeDetail(repo, workspace, 'commit', ref.slice(0, 8));
    expect(details).toMatchObject({ node: { ref, head: ref, parents: [base], branches: ['main'] },
      base, fileCount: 3, additions: 3, deletions: 1, partial: true });
    expect(details.statsCoverage).toBeUndefined();
    expect(details.files).toEqual([
      { path: 'binary.png', patch: null }, { path: 'main.txt', patch: expect.stringContaining('-before\n+after\n+extra') },
    ]);
    const approved = await readChangeWithPatches(repo, workspace, 'commit', ref);
    expect(approved.patches).toEqual([details.files[1]]);
    expect(approved.diff).toEqual(approved.patches[0]?.patch);
  });

  it('preserves saved changes and reports the Git read failure while offline', async () => {
    const offlineWorkspace = { ...workspace, source: join(root, 'missing') };
    const head = 'a'.repeat(40);
    const saved = { kind: 'commit' as const, ref: head, head, title: 'Saved item', author: '', date: '', parents: [], branches: [] };
    const history = await openRepositoryHistory(offlineWorkspace, root, { workspaceId: offlineWorkspace.id, cursor: 0 }, [saved]);
    const result = await history.advance(() => 1);
    expect(result.nodes).toEqual([saved]);
    expect(result.warning).toContain('Previously saved changes');
  });
});
