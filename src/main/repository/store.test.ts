import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoSelection } from '../../shared/repository';
import { openDatabase, type Db } from '../db/connection';
import { upsertConcept } from '../db/concepts';
import { recordEvidence } from '../db/evidence';
import { readWorkspaceCoverage, readWorkspaceGraph } from '../db/graph';
import { getGlobalKnowledgeGraph } from '../db/knowledge';
import { addWorkspace } from '../db/workspaces';
import { readLesson } from '../reader/ipc';
import { prepareTurn } from '../tutor/prompt';
import { selectModel } from '../providers/model';
import { baselineReply, changeReply } from './schemas';
import { cachedGeneration, digest, latestBrief, persistGeneration, useCachedGeneration, type ApprovedSource } from './store';

const mapped = baselineReply.parse({ schema: 'delve.map/1', concepts: [
  { key: 'nginx/proxy', title: 'Proxy', summary: 'Forwards requests', portable: true },
  { key: 'web/route', title: 'Routing policy', summary: 'Current routing decisions', portable: false },
], edges: [{ concept: 'web/route', prerequisite: 'nginx/proxy' }],
recommendation: { key: 'web/route', reason: 'Build on the proxy you have demonstrated.' } });
const baseline = 'a'.repeat(40);
const previous = 'b'.repeat(40);
const change = changeReply.parse({ ...mapped, schema: 'delve.change/1', touched: mapped.concepts.map(c => c.key), mechanics: null, boundary: null,
  trace: [], excerpt: [], what: 'The proxy now checks its route.', why: 'Avoid stale routes.',
  summary: 'Route validation', before: 'Old routes were retained.', after: 'Expired routes are removed.' });
let db: Db;
let workspaceId: string;

function source(selection: RepoSelection, commit: string): ApprovedSource {
  const revision = digest([selection, commit]);
  return { request: { workspaceId, selection, provider: 'codex', depth: 'medium' }, revision, cacheKey: digest([workspaceId, revision]),
    preview: { token: 'preview', prompt: 'preview', bytes: 7, files: ['src/routes.ts'], commit,
      title: 'Routing policy', ...selectModel('codex'), partial: true } };
}
beforeEach(() => {
  db = openDatabase(':memory:');
  workspaceId = addWorkspace(db, { kind: 'github', owner: 'acme', repo: 'web' }).id;
});
afterEach(() => db.close());

it('plans local usage in a new repository and only tops up the missing portable depth', () => {
  const first = workspaceId;
  const map = (key: string, title: string, usage: string) => baselineReply.parse({
    schema: 'delve.map/1',
    concepts: [{ key, title, summary: 'A reliable ordered byte stream.', portable: true },
      { key: usage, title: usage, summary: 'How the repository transports lease updates.', portable: false }],
    edges: [{ concept: usage, prerequisite: key }],
    recommendation: { key, reason: 'Start with the transport.' },
  });
  const selected = () => source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline);
  persistGeneration(db, selected(), map('Transmission-Control-Protocol', 'Transmission Control Protocol', 'dispatch-transport'));
  const tcp = readWorkspaceGraph(db, first).concepts.find(c => c.portable)!;
  expect(tcp.key).toBe('tcp');
  recordEvidence(db, { workspaceId: first, conceptId: tcp.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
  workspaceId = addWorkspace(db, { kind: 'github', owner: 'acme', repo: 'worker' }).id;
  persistGeneration(db, selected(), map(' TCP ', 'TCP', 'worker-lease-transport'));

  const graph = readWorkspaceGraph(db, workspaceId);
  const usage = graph.concepts.find(c => !c.portable)!;
  expect(graph.concepts.filter(c => c.portable)).toEqual([tcp]);
  expect(graph.evidence).toMatchObject([{ conceptId: tcp.id, depth: 'medium', workspaceId: first, status: 'demonstrated' }]);
  expect(graph.suggestions?.medium?.conceptId).toBe(usage.id);
  expect(getGlobalKnowledgeGraph(db).concepts.filter(c => c.portable)).toMatchObject([
    { id: tcp.id, masteredDepth: 'medium', learnedWorkspaceId: first,
      memberships: [{ workspaceId: first }, { workspaceId }] },
  ]);
  expect(graph.edges).toEqual([{ conceptId: usage.id, prerequisiteId: tcp.id }]);
  const preview = { workspaceId, provider: 'codex', intent: { kind: 'teach' } } as const;
  expect(prepareTurn(db, { ...preview, conceptId: usage.id, depth: 'medium' }).preview.prompt)
    .toContain('The learner already understands Transmission Control Protocol at medium depth; teach only how this repository uses it.');
  expect(prepareTurn(db, { ...preview, conceptId: tcp.id, depth: 'low' }).preview.prompt)
    .toContain('Teach and check only the additional detail needed at low depth.');
});

describe('atomic repository generation', () => {
  it('preserves canonical portable knowledge at its demonstrated depth and binds both concepts to the approved commit', () => {
    const prior = addWorkspace(db, { kind: 'topic', title: 'Reverse proxies' });
    const portable = upsertConcept(db, { workspaceId: prior.id, portable: true, key: 'nginx/proxy', title: 'NGINX reverse proxy', summary: 'Original definition' });
    recordEvidence(db, { workspaceId: prior.id, conceptId: portable.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
    const selected = source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline);
    persistGeneration(db, selected, mapped);
    expect(persistGeneration(db, selected, mapped)).toEqual({ kind: 'baseline' });
    const graph = readWorkspaceGraph(db, workspaceId);
    expect(graph.concepts).toHaveLength(2);
    expect(graph.concepts).toContainEqual(expect.objectContaining({ id: portable.id, title: 'NGINX reverse proxy', summary: 'Original definition' }));
    expect(graph.evidence).toMatchObject([{ workspaceId: prior.id, conceptId: portable.id, depth: 'medium' }]);
    expect(graph.edges).toEqual([{ prerequisiteId: portable.id, conceptId: graph.suggestions?.medium?.conceptId }]);
    expect(graph.suggestions?.medium?.reason).toContain('demonstrated');
    expect(graph.baselineCommit).toBe(baseline);
    expect(db.prepare('SELECT COUNT(*) AS n FROM snapshot_concepts').get()?.n).toBe(2);
    expect(readLesson(db, { workspaceId, conceptId: portable.id, depth: 'high' }).reused).toBe(true);
    expect(readLesson(db, { workspaceId, conceptId: portable.id, depth: 'medium' }).reused).toBe(true);
    expect(readLesson(db, { workspaceId, conceptId: portable.id, depth: 'low' }).reused).toBe(false);
  });

  it('restores the selected cached baseline and its local definitions after revisiting a revision', () => {
    const first = source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline);
    const second = source({ kind: 'baseline', commit: previous, paths: ['src/routes.ts'] }, previous);
    persistGeneration(db, first, mapped);
    persistGeneration(db, second, { ...mapped, concepts: mapped.concepts.map(c => ({ ...c, summary: 'Different routing policy' })) });
    expect(readWorkspaceGraph(db, workspaceId).baselineCommit).toBe(previous);
    expect(useCachedGeneration(db, first)).toEqual({ kind: 'baseline' });
    const graph = readWorkspaceGraph(db, workspaceId);
    expect(graph.snapshot).toBe(baseline);
    expect(graph.concepts.find(c => !c.portable)?.summary).toBe('Current routing decisions');
  });

  it('rolls back every write when the provider supplies an invalid graph or recommendation', () => {
    const selected = source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline);
    for (const invalid of [
      { ...mapped, edges: [{ concept: 'web/route', prerequisite: 'web/route' }] },
      { ...mapped, recommendation: { key: 'missing', reason: 'invalid' } },
      { ...mapped, concepts: [mapped.concepts[0]!, mapped.concepts[0]!] },
    ]) {
      expect(() => persistGeneration(db, selected, invalid)).toThrow();
      expect(readWorkspaceGraph(db, workspaceId)).toMatchObject({ concepts: [], snapshot: null });
      expect(cachedGeneration(db, selected.cacheKey)).toBeNull();
    }
  });

});

describe('change conversations', () => {
  it('saves a change as a chat lesson at its own commit without moving the baseline, and reads it offline by depth and model', () => {
    persistGeneration(db, source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline), mapped);
    const selection = { kind: 'commit', ref: previous } as const;
    const selected = source(selection, previous);
    const reply = change;
    const result = persistGeneration(db, selected, reply);
    expect(result.kind).toBe('change');
    if (result.kind !== 'change') throw new Error('missing brief');
    expect(readWorkspaceGraph(db, workspaceId).snapshot).toBe(baseline);
    expect(result.brief.touched.map(c => c.title)).toEqual(['Proxy', 'Routing policy']);
    expect(readLesson(db, { workspaceId, conceptId: result.brief.conceptId, depth: 'medium' })).toMatchObject({ source: previous,
      blocks: [{ text: reply.what }, { text: reply.why }, { before: reply.before, after: reply.after }, { heading: 'Partial coverage' }] });
    const address = { workspaceId, ...selection, depth: 'medium', provider: 'codex' } as const;
    expect(latestBrief(db, address)).toEqual(result.brief);
    expect(latestBrief(db, { ...address, depth: 'low' })).toBeNull();
    expect(latestBrief(db, { ...address, provider: 'claude' })).toBeNull();
  });
  it('retains the reviewed graph and coverage when an unmerged PR changes a definition and introduces a feature', () => {
    persistGeneration(db, source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline), mapped);
    const reviewed = readWorkspaceGraph(db, workspaceId);
    const newConcept = { key: 'web/new', title: 'New feature', summary: 'Only on the PR branch', portable: false };
    const proposal = { ...change, touched: ['web/route', newConcept.key], concepts: [...change.concepts.map(c => ({ ...c, title: 'PR title', summary: 'PR description' })), newConcept],
      edges: [{ concept: 'web/route', prerequisite: newConcept.key }], recommendation: { key: null, reason: 'Consider the change first.' } };
    const result = persistGeneration(db, source({ kind: 'pr', ref: '19' }, previous), proposal);
    if (result.kind !== 'change') throw new Error('Expected a change brief');
    const current = readWorkspaceGraph(db, workspaceId);
    expect(current.concepts).toEqual(reviewed.concepts);
    expect(current.edges).toEqual(reviewed.edges);
    expect(current.changeSuggestions?.medium).toMatchObject({ kind: 'pr', ref: '19', reason: 'Consider the change first.' });
    expect(current.snapshot).toBe(baseline);
    expect(readWorkspaceCoverage(db)).toMatchObject([{ total: 2 }]);
    expect(result.brief.touched.map(c => c.title)).toEqual(['Routing policy', 'New feature']);
    expect(readWorkspaceGraph(db, workspaceId, true).concepts).toHaveLength(4);
    expect(readLesson(db, { workspaceId, conceptId: result.brief.conceptId, depth: 'medium' }).source).toBe(previous);
  });

});
