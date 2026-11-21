import assert from 'node:assert/strict';
import { devNull } from 'node:os';
import { DomainError } from '../../shared/errors';
import { changeTitle, gitReader, nulRecords, readBlob, requireReachable, resolveCommit,
  type ChangeSnapshot, type GitReader } from './git-reader';
import { completedOutput } from './source-process';
import { isSourcePath, MAX_DIFF_BYTES, MAX_DIFF_FILES, MAX_PATCH_BYTES, OBJECT_ID, sourceText } from './source-policy';

const CHANGE_MODE = /^(?:000000|100644|100755)$/;
const DIFF_TREE_ARGS = ['diff-tree', '--root', '--no-commit-id', '--no-ext-diff', '--no-textconv',
  '--no-color', '--no-renames', '--no-relative', '--ignore-submodules=none', '-r', '-O', devNull];

interface ChangedFile {
  path: string;
  objects: string[];
  regular: boolean;
}

async function commitInfo(reader: GitReader, commit: string): Promise<{ title: string; parent: string | undefined }> {
  assert.ok(OBJECT_ID.test(commit));
  const raw = await reader.run(['cat-file', 'commit', commit], 128 * 1024);
  if (!raw.truncated) completedOutput(raw, 'Could not read the Git commit.');
  const headers = raw.output.indexOf('\n\n');
  if (headers < 0) throw new DomainError('SOURCE_READ_FAILED', 'Git did not return the commit headers.');
  const parent = /^parent ([a-f0-9]+)$/m.exec(raw.output.subarray(0, headers).toString('utf8'))?.[1];
  assert.ok(parent === undefined || OBJECT_ID.test(parent));
  const metadata = await reader.run(['log', '--no-notes', '--no-show-signature', '--encoding=UTF-8',
    '--max-count=1', '--format=%s', commit, '--'], 128 * 1024);
  if (!metadata.truncated) completedOutput(metadata, 'Could not read the Git commit title.');
  return { parent, title: changeTitle(metadata.output.toString('utf8')) };
}

async function changedFiles(reader: GitReader, revisions: string[]): Promise<{ files: ChangedFile[]; partial: boolean }> {
  assert.ok(revisions.length === 1 || revisions.length === 2);
  assert.ok(revisions.every(revision => OBJECT_ID.test(revision)));
  const raw = await reader.run([...DIFF_TREE_ARGS, '--raw', '--no-abbrev', '-z', ...revisions, '--'], 512 * 1024);
  if (!raw.truncated) completedOutput(raw, 'Could not list the files changed by that commit.');
  const records = nulRecords(raw.output);
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
  if (patch.truncated) return null;
  return sourceText(completedOutput(patch, 'Could not read a patch for that Git commit.')) || null;
}

export async function readGitChange(path: string, ref: string): Promise<ChangeSnapshot> {
  if (!/^[a-fA-F0-9]{7,64}$/.test(ref)) throw new DomainError('INVALID_COMMIT', 'Choose a hexadecimal Git commit ID.');
  const reader = await gitReader(path);
  const commit = await resolveCommit(reader, ref);
  await requireReachable(reader, commit);
  const { title, parent } = await commitInfo(reader, commit);
  const snapshot: ChangeSnapshot = { commit, title, diff: '', partial: false, files: [] };
  if (parent) {
    const check = await reader.run(['cat-file', '-t', parent], 1024);
    if (check.status !== 0) return { ...snapshot, partial: true };
    assert.equal(completedOutput(check, 'Could not read the parent of that commit.').toString('utf8').trim(), 'commit');
  }
  const revisions = parent ? [parent, commit] : [commit];
  const changes = await changedFiles(reader, revisions);
  snapshot.partial = changes.partial;
  let bytes = 0;
  for (const file of changes.files) {
    const patch = await textPatch(reader, revisions, file);
    const patchBytes = patch ? Buffer.byteLength(patch) : 0;
    if (!patch || bytes + patchBytes > MAX_DIFF_BYTES) {
      snapshot.partial = true;
      continue;
    }
    bytes += patchBytes;
    snapshot.diff += patch;
    snapshot.files.push(file.path);
  }
  assert.ok(bytes <= MAX_DIFF_BYTES);
  assert.ok(snapshot.files.length <= MAX_DIFF_FILES);
  return snapshot;
}
