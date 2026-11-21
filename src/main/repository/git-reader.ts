import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DomainError } from '../../shared/errors';
import { gitSource, completedOutput } from './source-process';
import { isSourcePath, MAX_BLOB_BYTES, MAX_READ_BYTES, MAX_READ_FILES, OBJECT_ID, sourceText } from './source-policy';

const MAX_TREE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 2_000;
const REGULAR_MODE = /^100(?:644|755)$/;

export interface GitChange {
  kind: 'commit' | 'pr';
  ref: string;
  title: string;
}

export interface ChangePatch {
  path: string;
  patch: string;
}

export interface ChangeSnapshot {
  commit: string;
  title: string;
  diff: string;
  base?: string;
  description?: string;
  coverageNote?: string;
  repository?: string;
  partial: boolean;
  files: string[];
}

export function withoutChangePatches(change: ChangeSnapshot & { patches: ChangePatch[] }): ChangeSnapshot {
  const { patches, ...snapshot } = change;
  assert.equal(snapshot.files.length, patches.length);
  assert.equal(snapshot.diff.length === 0, patches.length === 0);
  return snapshot;
}

interface SourceFile {
  path: string;
  bytes: number;
}

interface TreeFile extends SourceFile {
  object: string;
}

export interface GitReader {
  run: (args: string[], maxBytes?: number) => ReturnType<typeof gitSource>;
}

export async function gitReader(path: string): Promise<GitReader> {
  if (!isAbsolute(path)) throw new DomainError('INVALID_WORKSPACE', 'Choose an absolute repository path.');
  const marker = join(path, '.git');
  let directory = path;
  try {
    const info = await stat(marker);
    if (!info.isDirectory() && !info.isFile()) throw new DomainError('NOT_A_GIT_REPOSITORY', 'Invalid .git entry.');
    directory = marker;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  assert.ok(isAbsolute(directory));
  assert.ok(directory === path || directory === marker);
  return {
    run: (args, maxBytes) => gitSource(['--bare', `--git-dir=${directory}`, '--literal-pathspecs', ...args], { maxBytes }),
  };
}

export function nulRecords(output: Buffer): string[] {
  const records = output.toString('utf8').split('\0');
  records.pop();
  return records;
}

export class MissingSnapshotCommit extends DomainError {}

export async function resolveCommit(reader: GitReader, ref: string): Promise<string> {
  if (ref !== 'HEAD' && !/^[a-fA-F0-9]{7,64}$/.test(ref)) {
    throw new DomainError('INVALID_COMMIT', 'Choose a hexadecimal Git commit ID.');
  }
  const result = await reader.run(['rev-parse', '--quiet', '--verify', '--end-of-options', ref === 'HEAD' ? 'HEAD^{commit}' : `${ref.toLowerCase()}^{commit}`], 1024);
  if (ref !== 'HEAD' && result.status === 1 && !result.truncated) {
    throw new MissingSnapshotCommit('SOURCE_READ_FAILED', 'That Git commit is unavailable in the local snapshot.');
  }
  const commit = completedOutput(result, 'That Git commit is unavailable.').toString('utf8').trim();
  assert.ok(OBJECT_ID.test(commit), 'rev-parse must return one full commit ID');
  if (ref !== 'HEAD' && !commit.startsWith(ref.toLowerCase())) {
    throw new DomainError('INVALID_COMMIT', 'That hexadecimal ref does not identify a commit.');
  }
  return commit;
}

export async function requireReachable(reader: GitReader, commit: string): Promise<void> {
  assert.ok(OBJECT_ID.test(commit));
  const result = await reader.run(['for-each-ref', '--count=1', `--contains=${commit}`, '--format=%(objectname)',
    'refs/heads', 'refs/remotes', 'refs/tags'], 1024);
  const ref = completedOutput(result, 'Could not check whether that commit is reachable.').toString('utf8').trim();
  if (OBJECT_ID.test(ref)) return;
  assert.equal(ref, '', 'for-each-ref must return an object ID or no matches');
  const ancestor = await reader.run(['merge-base', '--is-ancestor', commit, 'HEAD'], 1024);
  if (ancestor.status === 1) throw new MissingSnapshotCommit('INVALID_COMMIT', 'That commit is outside the available repository history.');
  completedOutput(ancestor, 'Could not check whether that commit is reachable from HEAD.');
}

async function treeFiles(reader: GitReader, commit: string, paths: string[] = []): Promise<{ files: TreeFile[]; partial: boolean }> {
  assert.ok(OBJECT_ID.test(commit));
  assert.ok(paths.every(isSourcePath));
  const traversal = paths.length === 0 ? ['-r'] : [];
  const result = await reader.run(['ls-tree', '--full-tree', ...traversal, '-l', '-z', commit, '--', ...paths], MAX_TREE_BYTES);
  if (!result.truncated) completedOutput(result, 'Could not read the files of that Git snapshot.');
  const files: TreeFile[] = [];
  let partial = result.truncated;
  for (const entry of nulRecords(result.output)) {
    const row = /^(\d+) (\S+) ([a-f0-9]+) +(\d+|-|BAD)\t([\s\S]+)$/.exec(entry);
    if (!row) throw new DomainError('SOURCE_READ_FAILED', 'Git returned a malformed tree entry.');
    const [, mode, type, object, size, path] = row;
    assert.ok(mode && type && object && size && path);
    const bytes = Number(size);
    if (files.length === MAX_FILES) {
      partial = true;
      break;
    }
    if (REGULAR_MODE.test(mode) && type === 'blob' && isSourcePath(path) && Number.isSafeInteger(bytes) && bytes <= MAX_BLOB_BYTES) {
      assert.ok(OBJECT_ID.test(object));
      assert.ok(bytes >= 0);
      files.push({ path, object, bytes });
    } else {
      partial = true;
    }
  }
  return { files, partial };
}

export async function listGitFiles(path: string): Promise<{ commit: string; files: SourceFile[]; partial: boolean }> {
  const reader = await gitReader(path);
  const commit = await resolveCommit(reader, 'HEAD');
  const { files, partial } = await treeFiles(reader, commit);
  return { commit, files: files.map(({ path, bytes }) => ({ path, bytes })), partial };
}

export async function readBlob(reader: GitReader, object: string, bytes?: number): Promise<string | null> {
  assert.ok(OBJECT_ID.test(object) && !/^0+$/.test(object));
  assert.ok(bytes === undefined || (bytes >= 0 && bytes <= MAX_BLOB_BYTES));
  const result = await reader.run(['cat-file', 'blob', object], MAX_BLOB_BYTES);
  if (result.truncated || (result.status !== 0
    && /: bad file|could not fetch .* from promisor remote/.test(result.diagnostic))) return null;
  const output = completedOutput(result, 'Could not read a file in the selected Git snapshot.');
  assert.ok(bytes === undefined || bytes === output.length, 'immutable blob size must match its tree entry');
  return sourceText(output);
}

export async function readGitFiles(path: string, commit: string, paths: string[]): Promise<{ path: string; text: string }[]> {
  if (!OBJECT_ID.test(commit)) throw new DomainError('INVALID_COMMIT', 'The snapshot must specify a full Git commit ID.');
  if (paths.length > MAX_READ_FILES) throw new DomainError('SOURCE_LIMIT', 'Too many files were selected for the repository read.');
  const requested = [...new Set(paths.filter(isSourcePath))];
  const reader = await gitReader(path);
  const type = await reader.run(['cat-file', '-t', commit], 1024);
  if (completedOutput(type, 'That Git snapshot is unavailable.').toString('utf8').trim() !== 'commit') {
    throw new DomainError('INVALID_COMMIT', 'The snapshot must identify a Git commit.');
  }
  await requireReachable(reader, commit);
  const files: { path: string; text: string }[] = [];
  let bytes = 0;
  for (let offset = 0; offset < requested.length; offset += 16) {
    const batch = requested.slice(offset, offset + 16);
    const { files: entries } = await treeFiles(reader, commit, batch);
    const byPath = new Map(entries.map(entry => [entry.path, entry]));
    for (const path of batch) {
      const entry = byPath.get(path);
      if (!entry || bytes + entry.bytes > MAX_READ_BYTES) continue;
      const text = await readBlob(reader, entry.object, entry.bytes);
      if (text === null) continue;
      bytes += entry.bytes;
      files.push({ path, text });
    }
  }
  assert.ok(bytes <= MAX_READ_BYTES);
  assert.ok(files.length <= requested.length);
  return files;
}

export function changeTitle(value: string): string {
  const title = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  return sourceText(Buffer.from(title)) ? Array.from(title).slice(0, 240).join('') : 'Untitled change';
}

export async function listGitChanges(path: string): Promise<{ changes: GitChange[]; warning: string | null }> {
  const reader = await gitReader(path);
  const commit = await resolveCommit(reader, 'HEAD');
  const result = await reader.run(['log', '--no-notes', '--no-show-signature', '--no-color', '--encoding=UTF-8',
    '-z', '--max-count=25', '--format=%H%x00%s', commit, '--'], 256 * 1024);
  if (!result.truncated) completedOutput(result, 'Could not read recent commits.');
  const records = nulRecords(result.output);
  const changes: GitChange[] = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const [ref, title] = [records[i], records[i + 1]];
    assert.ok(ref && OBJECT_ID.test(ref));
    assert.ok(title !== undefined);
    changes.push({ kind: 'commit', ref, title: changeTitle(title) });
  }
  return { changes, warning: result.truncated ? 'The recent Git commit list exceeded the read limit.' : null };
}
