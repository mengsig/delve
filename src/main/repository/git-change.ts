import assert from 'node:assert/strict';
import type { ChangeDetail } from '../../shared/explorer';
import { gitOutput } from './git-diagnostics';
import { gitHistoryNode, readCommitLog } from './git-history';
import { DomainError } from '../../shared/errors';
import { changeTitle, gitReader, nulRecords, readBlob, requireReachable, resolveCommit,
  withoutChangePatches, type ChangeSnapshot, type ChangePatch, type GitReader } from './git-reader';
import { GIT_NULL_FILE } from './source-process';
import { isSourcePath, MAX_DIFF_BYTES, MAX_DIFF_FILES, MAX_PATCH_BYTES, OBJECT_ID, sourceText } from './source-policy';

const CHANGE_MODE = /^(?:000000|100644|100755)$/;
const COMMIT_LIMIT = 128 * 1024;
const DIFF_LIST_LIMIT = 512 * 1024;
const DIFF_TREE_ARGS = ['diff-tree', '--root', '--no-commit-id', '--no-ext-diff', '--no-textconv',
  '--no-color', '--no-renames', '--no-relative', '--ignore-submodules=none', '-r', '-O', GIT_NULL_FILE];

interface ChangedFile {
  path: string;
  objects: string[];
  regular: boolean;
}

async function commitInfo(reader: GitReader, commit: string): Promise<{ title: string; parents: string[]; description?: string }> {
  assert.ok(OBJECT_ID.test(commit));
  const raw = await reader.run(['cat-file', 'commit', commit], COMMIT_LIMIT);
  const content = gitOutput(raw, 'Could not read the Git commit.', COMMIT_LIMIT);
  const headers = content.indexOf('\n\n');
  if (headers < 0) throw new DomainError('SOURCE_READ_FAILED', 'Git did not return the commit headers.');
  const parents = [...content.subarray(0, headers).toString('utf8').matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => match[1] ?? '');
  assert.ok(parents.every(parent => OBJECT_ID.test(parent)));
  const metadata = await readCommitLog(reader, commit, parents, '%s', COMMIT_LIMIT);
  const title = gitOutput(metadata, 'Could not read the Git commit title.', COMMIT_LIMIT).toString('utf8');
  const message = sourceText(content.subarray(headers + 2));
  const body = message?.split(/\n\s*\n/).slice(1).join('\n\n').trim().slice(0, 4000);
  return { parents, title: changeTitle(title), description: body || undefined };
}

async function changedFiles(reader: GitReader, revisions: string[]): Promise<{ files: ChangedFile[]; partial: boolean }> {
  assert.ok(revisions.length === 1 || revisions.length === 2);
  assert.ok(revisions.every(revision => OBJECT_ID.test(revision)));
  const raw = await reader.run([...DIFF_TREE_ARGS, '--raw', '--no-abbrev', '-z', ...revisions, '--'], DIFF_LIST_LIMIT);
  const records = nulRecords(gitOutput(raw, 'Could not list the files changed by that commit.', DIFF_LIST_LIMIT));
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < records.length && files.length < MAX_DIFF_FILES; i += 2) {
    const [header, path] = [records[i], records[i + 1]];
    const match = /^:(\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) [A-Z]$/.exec(header ?? '');
    if (!match || !path) throw new DomainError('SOURCE_READ_FAILED', 'Git returned a malformed change entry.');
    const [, oldMode, newMode, oldObject, newObject] = match;
    assert.ok(oldMode && newMode && oldObject && newObject);
    assert.ok(OBJECT_ID.test(oldObject) && OBJECT_ID.test(newObject));
    const objects = [oldObject, newObject].filter(object => !/^0+$/.test(object));
    assert.ok(objects.length > 0);
    files.push({ path, objects, regular: CHANGE_MODE.test(oldMode) && CHANGE_MODE.test(newMode) });
  }
  return { files, partial: raw.truncated || records.length !== files.length * 2 };
}

async function textPatch(reader: GitReader, revisions: string[], file: ChangedFile): Promise<string | null> {
  if (!file.regular || !isSourcePath(file.path)) return null;
  for (const id of new Set(file.objects)) {
    if (await readBlob(reader, id) === null) return null;
  }
  const patch = await reader.run([...DIFF_TREE_ARGS, '-p', '--text', '--full-index',
    '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', ...revisions, '--', file.path], MAX_PATCH_BYTES);
  const output = gitOutput(patch, 'Could not read a patch for that Git commit.', MAX_PATCH_BYTES);
  if (patch.truncated) return null;
  return sourceText(output) || null;
}

async function openGitChange(path: string, ref: string) {
  if (!/^[a-fA-F0-9]{7,64}$/.test(ref)) throw new DomainError('INVALID_COMMIT', 'Choose a hexadecimal Git commit ID.');
  const reader = await gitReader(path);
  const commit = await resolveCommit(reader, ref);
  await requireReachable(reader, commit);
  const { title, parents, description } = await commitInfo(reader, commit);
  const [parent] = parents;
  const snapshot: ChangeSnapshot = { commit, base: parent, title, description, diff: '', partial: false, files: [] };
  const revisions = parent ? [parent, commit] : [commit];
  if (parent) {
    const check = await reader.run(['cat-file', '-t', parent], 1024);
    const errors = check.diagnostic.split(/\r?\n/).filter(line => /^(?:fatal|error):/.test(line));
    if (!check.truncated && check.status === 128 && check.output.length === 0
      && errors.length === 1 && errors[0] === 'fatal: git cat-file: could not get object info') {
      const coverageNote = `Git parent ${parent} is missing from the local snapshot.`;
      return { reader, snapshot: { ...snapshot, partial: true, coverageNote }, revisions: null, parents };
    }
    assert.equal(gitOutput(check, 'Could not read the parent of that commit.').toString('utf8').trim(), 'commit');
  }
  assert.ok(revisions.every(revision => OBJECT_ID.test(revision)));
  assert.equal(revisions.at(-1), snapshot.commit);
  return { reader, snapshot, revisions, parents };
}

async function collectGitPatches(reader: GitReader, revisions: string[]) {
  const changes = await changedFiles(reader, revisions);
  const files: ChangeDetail['files'] = [];
  let partial = changes.partial;
  let bytes = 0;
  for (const file of changes.files) {
    const patch = await textPatch(reader, revisions, file);
    const patchBytes = patch ? Buffer.byteLength(patch) : 0;
    const readable = patch !== null && bytes + patchBytes <= MAX_DIFF_BYTES;
    if (!readable) partial = true;
    if (isSourcePath(file.path)) files.push({ path: file.path, patch: readable ? patch : null });
    if (readable) bytes += patchBytes;
  }
  assert.ok(bytes <= MAX_DIFF_BYTES);
  assert.ok(files.length <= MAX_DIFF_FILES);
  return { files, partial };
}

export async function readGitChange(path: string, ref: string): Promise<ChangeSnapshot> {
  return withoutChangePatches(await readGitChangeWithPatches(path, ref));
}

export async function readGitChangeWithPatches(path: string, ref: string): Promise<ChangeSnapshot & { patches: ChangePatch[] }> {
  const { reader, snapshot, revisions } = await openGitChange(path, ref);
  if (!revisions) return { ...snapshot, patches: [] };
  const { files, partial } = await collectGitPatches(reader, revisions);
  const patches = files.flatMap(file => file.patch === null ? [] : [{ path: file.path, patch: file.patch }]);
  assert.ok(patches.length <= files.length);
  assert.ok(patches.every(file => isSourcePath(file.path)));
  return { ...snapshot, partial, patches, files: patches.map(file => file.path), diff: patches.map(file => file.patch).join('') };
}

async function gitStats(reader: GitReader, revisions: string[]) {
  assert.ok(revisions.length === 1 || revisions.length === 2);
  assert.ok(revisions.every(revision => OBJECT_ID.test(revision)));
  const result = await reader.run([...DIFF_TREE_ARGS, '--numstat', '-z', ...revisions, '--'], DIFF_LIST_LIMIT);
  const records = nulRecords(gitOutput(result, 'Could not count the files and lines changed by that Git commit.', DIFF_LIST_LIMIT));
  let additions = 0;
  let deletions = 0;
  for (const entry of records) {
    const fields = /^(\d+|-)\t(\d+|-)\t[\s\S]+$/.exec(entry);
    if (!fields) throw new DomainError('SOURCE_READ_FAILED', 'Git returned malformed change statistics.');
    if (fields[1] === '-' && fields[2] === '-') continue;
    additions += Number(fields[1]);
    deletions += Number(fields[2]);
  }
  assert.ok(Number.isSafeInteger(additions) && additions >= 0);
  assert.ok(Number.isSafeInteger(deletions) && deletions >= 0);
  return { fileCount: records.length, additions, deletions, limited: result.truncated };
}

export async function readGitDetail(path: string, ref: string): Promise<ChangeDetail> {
  const { reader, snapshot, revisions, parents } = await openGitChange(path, ref);
  const node = await gitHistoryNode(reader, snapshot.commit, parents);
  const base = snapshot.base;
  const common = { node, base, description: snapshot.description };
  if (!revisions) {
    assert.ok(snapshot.partial && snapshot.coverageNote);
    return { ...common, files: [], fileCount: 0, additions: 0, deletions: 0, partial: true, statsCoverage: 'unavailable',
      coverageNote: snapshot.coverageNote + ' File and line totals are unavailable.' };
  }
  const [changes, stats] = await Promise.allSettled([collectGitPatches(reader, revisions), gitStats(reader, revisions)]);
  if (changes.status === 'rejected') throw changes.reason;
  const { files, partial } = changes.value;
  if (stats.status === 'rejected') {
    if (!(stats.reason instanceof DomainError)) throw stats.reason;
    return { ...common, files, fileCount: 0, additions: 0, deletions: 0, partial: true, statsCoverage: 'unavailable',
      coverageNote: stats.reason.message + ' File and line totals are unavailable.' };
  }
  const { limited, ...totals } = stats.value;
  assert.equal(node.head, snapshot.commit);
  assert.ok(limited || files.length <= totals.fileCount);
  return { ...common, ...totals, files, partial: partial || limited, statsCoverage: limited ? 'lower-bound' : undefined,
    coverageNote: limited ? 'Some files or patches are unavailable. File and line totals are lower bounds.'
      : partial ? 'Some file patches are unavailable. Totals cover the whole change.' : undefined };
}
