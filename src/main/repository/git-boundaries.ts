import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DomainError } from '../../shared/errors';
import { gitOutput, gitReadFailed, gitReadState } from './git-diagnostics';
import { headTip, REACHABILITY_REFS, reachabilityDiagnostics, type GitReader } from './git-reader';
import { OBJECT_ID } from './source-policy';
import { gitSource } from './source-process';

export interface BrokenBoundary {
  missing: Set<string>;
  parents: string[];
}

const SETUP_FAILED = 'Could not prepare a private Git history walk.';
const MAX_SHALLOW_BYTES = 1024 * 1024;
const MAX_REF_BYTES = 4 * 1024 * 1024;
const MAX_REPAIR_COMMIT_BYTES = 16 * 1024 * 1024;
const MAX_REPAIR_COMMITS = 256;

interface ByteBudget {
  remaining: number;
}

async function* limitBytes(chunks: AsyncIterable<Buffer>, budget: ByteBudget) {
  assert.ok(Number.isSafeInteger(budget.remaining) && budget.remaining >= 0);
  for await (const chunk of chunks) {
    assert.ok(Buffer.isBuffer(chunk));
    if (chunk.length > budget.remaining) {
      throw new DomainError('SOURCE_LIMIT', 'Private Git history data exceeded the read limit.');
    }
    budget.remaining -= chunk.length;
    yield chunk;
  }
}

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
  const file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  });
  if (!file) return;
  try {
    if (!(await file.stat()).isFile()) throw new DomainError('SOURCE_READ_FAILED', SETUP_FAILED);
    await pipeline(file.createReadStream(), chunks => limitBytes(chunks, { remaining: MAX_SHALLOW_BYTES }),
      createWriteStream(join(directory, 'shallow')));
  } finally {
    await file.close();
  }
}

async function copyReachabilityRefs(reader: GitReader, directory: string): Promise<void> {
  assert.ok(isAbsolute(directory));
  const result = await reader.stream(['for-each-ref', '--sort=refname', '--format=%(objectname) %(refname)', ...REACHABILITY_REFS],
    stream => pipeline(stream, chunks => limitBytes(chunks, { remaining: MAX_REF_BYTES }),
      createWriteStream(join(directory, 'packed-refs'))));
  if (reachabilityDiagnostics(result).length) gitReadFailed(result, SETUP_FAILED);
  gitOutput(result, SETUP_FAILED);
  const head = await headTip(reader);
  assert.ok(head === null || OBJECT_ID.test(head));
  await writeFile(join(directory, 'HEAD'), head ? head + '\n' : 'ref: refs/delve/unborn\n');
}

async function* withoutMissingParents(stream: AsyncIterable<Buffer>, commit: string, { parents, missing }: BrokenBoundary) {
  assert.ok(OBJECT_ID.test(commit) && parents.every(parent => parent.length === commit.length && OBJECT_ID.test(parent)));
  assert.ok(missing.size > 0 && [...missing].every(parent => parents.includes(parent)));
  const expected = Buffer.from(parents.map(parent => `parent ${parent}\n`).join(''));
  const kept = Buffer.from(parents.filter(parent => !missing.has(parent)).map(parent => `parent ${parent}\n`).join(''));
  const treeLength = commit.length + 'tree \n'.length;
  const headerLength = treeLength + expected.length;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    if (bytes >= headerLength) {
      yield chunk;
      continue;
    }
    chunks.push(chunk);
    bytes += chunk.length;
    if (bytes < headerLength) continue;
    const prefix = Buffer.concat(chunks, bytes);
    chunks.length = 0;
    const tree = prefix.subarray(0, treeLength);
    if (!/^tree [a-fA-F0-9]+\n$/.test(tree.toString('latin1'))
      || !prefix.subarray(treeLength, headerLength).equals(expected)) {
      throw new DomainError('SOURCE_READ_FAILED', SETUP_FAILED);
    }
    yield tree;
    yield kept;
    yield prefix.subarray(headerLength);
  }
  if (bytes < headerLength) throw new DomainError('SOURCE_READ_FAILED', SETUP_FAILED);
}

async function* withReplacementHeader(chunks: AsyncIterable<Buffer>) {
  // A parent-stripped commit can otherwise match an original commit missing elsewhere in the walk.
  const header = Buffer.from(`delve-replacement ${randomBytes(32).toString('hex')}\n`);
  let added = false;
  let previousEndedInNewline = false;
  for await (const chunk of chunks) {
    assert.ok(Buffer.isBuffer(chunk));
    if (chunk.length === 0) continue;
    if (added) {
      yield chunk;
      continue;
    }
    const startsWithSeparator: boolean = previousEndedInNewline && chunk[0] === 10;
    const separator = chunk.indexOf('\n\n');
    if (startsWithSeparator || separator !== -1) {
      const offset: number = startsWithSeparator ? 0 : separator + 1;
      assert.equal(chunk[offset], 10);
      yield chunk.subarray(0, offset);
      yield header;
      yield chunk.subarray(offset);
      added = true;
      continue;
    }
    yield chunk;
    previousEndedInNewline = chunk.at(-1) === 10;
  }
  if (!added) {
    if (!previousEndedInNewline) yield Buffer.from('\n');
    yield header;
  }
}

async function writeReplacement(reader: GitReader, directory: string,
  commit: string, boundary: BrokenBoundary, budget: ByteBudget): Promise<void> {
  assert.ok(OBJECT_ID.test(commit));
  assert.ok(isAbsolute(directory));
  const file = join(directory, 'replacement');
  const original = await reader.stream(['cat-file', 'commit', commit], stream => pipeline(stream,
    chunks => withReplacementHeader(withoutMissingParents(limitBytes(chunks, budget), commit, boundary)),
    createWriteStream(file)));
  gitOutput(original, SETUP_FAILED);
  // Keep the source alternate off writes, and retain metadata Git can read even if it would fail fsck.
  const result = await gitSource(['--bare', `--git-dir=${directory}`, 'hash-object', '-w', '-t', 'commit',
    '--literally', '--', file], { maxBytes: 4096 });
  const replacement = gitOutput(result, SETUP_FAILED).toString('ascii').trim();
  assert.ok(OBJECT_ID.test(replacement) && replacement.length === commit.length);
  assert.notEqual(replacement, commit);
  await writeFile(join(directory, 'refs', 'replace', commit), replacement + '\n');
  await rm(file);
}

function privateRead(reader: GitReader, directory: string, alternate: string, commit: string): GitReader['run'] {
  assert.ok(isAbsolute(directory) && isAbsolute(alternate));
  assert.ok(OBJECT_ID.test(commit));
  return async (args, maxBytes) => {
    if (args[0] === 'log') {
      // Parse the source log configuration without following the damaged parent chain.
      const probe = await reader.run(['log', '--no-walk=unsorted', '--max-count=0', '--format=', commit, '--'], maxBytes);
      if (gitReadState(probe) !== 'complete') return probe;
      assert.equal(probe.output.length, 0);
    }
    return gitSource(['--bare', `--git-dir=${directory}`, '--literal-pathspecs', ...args], { maxBytes, isolatedGit: { alternate } });
  };
}

export async function withBoundaries<T>(reader: GitReader, boundaries: Map<string, BrokenBoundary>,
  action: (reader: GitReader) => Promise<T>, scope: 'history' | 'reachability' = 'history'): Promise<T> {
  if (boundaries.size === 0) return action(reader);
  if (boundaries.size > MAX_REPAIR_COMMITS) throw new DomainError('SOURCE_LIMIT', 'Too many Git commits need history repair.');
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
    await copyShallowFile(reader, directory);
    if (scope === 'reachability') await copyReachabilityRefs(reader, directory);
    await mkdir(join(directory, 'refs', 'replace'));
    const budget = { remaining: MAX_REPAIR_COMMIT_BYTES };
    for (const [id, boundary] of entries) await writeReplacement(reader, directory, id, boundary, budget);
    return await action({ run: privateRead(reader, directory, alternate, commit), stream: reader.stream });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
