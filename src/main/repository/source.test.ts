import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/domain';
import { listChanges, listFiles, readChange, readFiles, repositoryPath } from './source';

let root: string;
let repo: string;
let workspace: Workspace;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(title: string): string {
  git('add', '--all');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', title);
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
    commit('Baseline');
    await writeFile(join(repo, 'main.ts'), 'new\n');
    const head = commit('Change');
    const shallow = join(root, 'shallow.git');
    git('clone', '--bare', '--depth=1', '--no-local', repo, shallow);
    expect(await readChange(shallow, workspace, 'commit', head)).toMatchObject({
      commit: head, title: 'Change', diff: '', files: [], partial: true,
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
