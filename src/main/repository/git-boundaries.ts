import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gitOutput, gitReadFailed } from './git-diagnostics';
import { headTip, REACHABILITY_REFS, reachabilityDiagnostics, type GitReader } from './git-reader';
import { OBJECT_ID } from './source-policy';
import { gitSource } from './source-process';

export interface BrokenBoundary {
  missing: Set<string>;
  parents: string[];
}

const SETUP_FAILED = 'Could not prepare a private Git history walk.';

async function repositoryPath(reader: GitReader, entry: 'objects' | 'shallow'): Promise<string> {
  const result = await reader.run(['rev-parse', '--path-format=absolute', '--git-path', entry], 64 * 1024);
  const output = gitOutput(result, SETUP_FAILED).toString('utf8');
  assert.ok(output.endsWith('\n'));
  const path = output.slice(0, -1);
  assert.ok(isAbsolute(path) && !path.includes('\0'));
  return path;
}

async function copyShallowFile(reader: GitReader, directory: string): Promise<void> {
  const source = await repositoryPath(reader, 'shallow');
  try {
    await copyFile(source, join(directory, 'shallow'));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
}

async function copyReachabilityRefs(reader: GitReader, directory: string): Promise<void> {
  assert.ok(isAbsolute(directory));
  const result = await reader.stream(['for-each-ref', '--sort=refname', '--format=%(objectname) %(refname)', ...REACHABILITY_REFS],
    stream => pipeline(stream, createWriteStream(join(directory, 'packed-refs'))));
  if (reachabilityDiagnostics(result).length) gitReadFailed(result, SETUP_FAILED);
  gitOutput(result, SETUP_FAILED);
  const head = await headTip(reader);
  assert.ok(head === null || OBJECT_ID.test(head));
  await writeFile(join(directory, 'HEAD'), head ? head + '\n' : 'ref: refs/delve/unborn\n');
}

async function* withoutMissingParents(stream: Readable, commit: string, { parents, missing }: BrokenBoundary) {
  assert.ok(OBJECT_ID.test(commit) && parents.every(parent => parent.length === commit.length && OBJECT_ID.test(parent)));
  assert.ok(missing.size > 0 && [...missing].every(parent => parents.includes(parent)));
  const expected = parents.map(parent => `parent ${parent}\n`).join('');
  const kept = parents.filter(parent => !missing.has(parent)).map(parent => `parent ${parent}\n`).join('');
  const treeLength = commit.length + 'tree \n'.length;
  const headerLength = treeLength + expected.length;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (bytes >= headerLength) {
      yield chunk;
      continue;
    }
    chunks.push(chunk);
    bytes += chunk.length;
    if (bytes < headerLength) continue;
    const prefix = Buffer.concat(chunks, bytes);
    chunks.length = 0;
    assert.match(prefix.subarray(0, treeLength).toString('ascii'), /^tree [a-f0-9]+\n$/);
    assert.equal(prefix.subarray(treeLength, headerLength).toString('ascii'), expected);
    yield prefix.subarray(0, treeLength);
    yield Buffer.from(kept);
    yield prefix.subarray(headerLength);
  }
}

async function writeReplacement(reader: GitReader, run: GitReader['run'], directory: string,
  commit: string, boundary: BrokenBoundary): Promise<void> {
  assert.ok(OBJECT_ID.test(commit));
  assert.ok(isAbsolute(directory));
  const file = join(directory, 'replacement');
  const original = await reader.stream(['cat-file', 'commit', commit], stream =>
    pipeline(withoutMissingParents(stream, commit, boundary), createWriteStream(file)));
  gitOutput(original, SETUP_FAILED);
  const result = await run(['hash-object', '-w', '-t', 'commit', '--no-filters', '--', file], 4096);
  const replacement = gitOutput(result, SETUP_FAILED).toString('ascii').trim();
  assert.ok(OBJECT_ID.test(replacement) && replacement.length === commit.length);
  assert.notEqual(replacement, commit);
  await writeFile(join(directory, 'refs', 'replace', commit), replacement + '\n');
  await rm(file);
}

export async function withBoundaries<T>(reader: GitReader, boundaries: Map<string, BrokenBoundary>,
  action: (reader: GitReader) => Promise<T>, scope: 'history' | 'reachability' = 'history'): Promise<T> {
  if (boundaries.size === 0) return action(reader);
  const entries = [...boundaries];
  const commit = entries[0]?.[0];
  assert.ok(commit && OBJECT_ID.test(commit));
  assert.ok(entries.every(([id]) => OBJECT_ID.test(id) && id.length === commit.length));
  const alternate = await repositoryPath(reader, 'objects');
  const directory = await mkdtemp(join(tmpdir(), 'delve-history-'));
  try {
    const objectFormat = commit.length === 40 ? 'sha1' : 'sha256';
    const init = await gitSource(['-c', 'init.defaultRefFormat=files', 'init', '--quiet', '--bare', '--template=',
      `--object-format=${objectFormat}`, directory]);
    gitOutput(init, SETUP_FAILED);
    // The source object store is an alternate. All objects and refs we write belong to this directory.
    const run: GitReader['run'] = (args, maxBytes) =>
      gitSource(['--bare', `--git-dir=${directory}`, '--literal-pathspecs', ...args], { maxBytes, isolatedGit: { alternate } });
    await copyShallowFile(reader, directory);
    if (scope === 'reachability') await copyReachabilityRefs(reader, directory);
    await mkdir(join(directory, 'refs', 'replace'));
    for (const [id, boundary] of entries) await writeReplacement(reader, run, directory, id, boundary);
    return await action({ run, stream: reader.stream });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
