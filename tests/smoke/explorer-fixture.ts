import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const start = Date.parse('2026-10-22T08:00:00Z') / 1000;
const owner = 'Maya Chen <maya@example.invalid>';

interface Commit {
  title: string;
  branch: string;
  path?: string;
  content?: string;
  parent?: number;
  merge?: number;
}

function record(commit: Commit, mark: number) {
  const data = (text: string) => 'data ' + Buffer.byteLength(text) + '\n' + text;
  const header = ['commit refs/heads/' + commit.branch, 'mark :' + mark, 'committer ' + owner + ' ' + (start + mark * 60) + ' +0000', data(commit.title)];
  if (commit.parent) header.push('from :' + commit.parent);
  if (commit.merge) header.push('merge :' + commit.merge);
  if (commit.path && commit.content) header.push('M 100644 inline ' + commit.path, data(commit.content));
  return header.join('\n') + '\n\n';
}

export const prTitle = 'Retry transient delivery failures';
export const concept = { key: 'dispatch/retries', title: 'Delivery retries', portable: false,
  summary: 'A delivery can be attempted again when a failure clears.' };
export const newConcept = { key: 'dispatch/retry-budget', title: 'Retry budget', portable: false,
  summary: 'The worker has a bounded number of delivery attempts.' };
export const baseline = { concepts: [concept], edges: [], recommendation: { key: concept.key, reason: 'Follow a delivery through the dispatcher.' } };
const code = ['export async function dispatch(job: Job) {', '  const attempts = 1;', '  return deliver(job, attempts);', '}'];
const after = code.map(line => line.replace('attempts = 1', 'attempts = 3')).join('\n') + '\n';
const modified = { filename: 'src/dispatch.ts', status: 'modified', additions: 1, deletions: 1,
  patch: ['@@ -1,4 +1,4 @@', ' ' + code[0], '-' + code[1], '+  const attempts = 3;', ' ' + code[2], ' ' + code[3]].join('\n') };

export function createExplorerFixture(directory: string) {
  const path = join(directory, 'dispatch');
  mkdirSync(path);
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet', '--template=', '--initial-branch=main');
  git('remote', 'add', 'origin', 'https://github.com/contour/dispatch.git');
  const history: Commit[] = [{ title: 'Start the dispatcher', branch: 'main', path: modified.filename, content: code.join('\n') + '\n' }];
  for (let i = 1; i <= 240; i++) history.push({ title: 'Record dispatch sample ' + i, branch: 'main' });
  history.push({ title: 'Describe delivery outcomes', branch: 'main', path: 'docs/delivery.md', content: 'Delivery outcomes\n' });
  const baseMark = history.length;
  history.push({ title: 'Retry a failed dispatch', branch: 'retry-delivery', parent: baseMark, path: modified.filename, content: after },
    { title: 'Document delivery timeouts', branch: 'main', path: 'docs/delivery.md', content: 'Timeouts can be transient.\n' },
    { title: 'Merge delivery retries', branch: 'main', merge: baseMark + 1, path: modified.filename, content: after });
  execFileSync('git', ['-C', path, 'fast-import', '--quiet'], { input: history.map((entry, i) => record(entry, i + 1)).join('') + 'done\n' });
  const head = git('rev-parse', 'retry-delivery');
  const base = git('rev-parse', 'main^1');
  const pr = { title: prTitle, number: 42, state: 'closed', user: { login: 'mayachen' },
    body: 'Delivery workers now retry a transient failure before returning the job to the queue.',
    base: { sha: base, ref: 'main' }, head: { sha: head, ref: 'retry-delivery' },
    created_at: '2026-10-22T15:00:00Z', updated_at: '2026-10-23T08:00:00Z', closed_at: '2026-10-23T08:00:00Z',
    merged_at: '2026-10-23T08:00:00Z', merged: true, changed_files: 2, additions: 5, deletions: 1 };
  writeFileSync(join(directory, 'github.json'), JSON.stringify({ pr, files: [modified,
    { filename: 'docs/delivery.md', additions: 4, deletions: 0, status: 'modified', patch: null }] }));
  return { path, head };
}

export function writeExplanation(directory: string) {
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ ...baseline, schema: 'delve.change/1', concepts: [concept, newConcept], touched: [concept.key, newConcept.key],
    summary: 'A failed delivery gets two more attempts before the dispatcher gives up.',
    what: 'The retry budget increases from one attempt to three.', why: 'A short network interruption can clear between attempts.',
    before: 'The first failure ended the delivery.', after: 'The worker can try the same job again.',
    mechanics: 'The dispatcher passes the new attempt limit into the delivery loop.', boundary: null, trace: [], excerpt: [],
    spans: [{ key: concept.key, path: modified.filename, side: 'new', start: 2, end: 2 }] }));
}
