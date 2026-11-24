import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoSelection } from '../../shared/repository';
import { openDatabase, type Db } from '../db/connection';
import { upsertConcept } from '../db/concepts';
import { recordEvidence, resetEvidence } from '../db/evidence';
import { readWorkspaceCoverage, readWorkspaceGraph } from '../db/graph';
import { getGlobalKnowledgeGraph } from '../db/knowledge';
import { addWorkspace } from '../db/workspaces';
import { readLesson, readerHandlers } from '../reader/ipc';
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

it('keeps the high-depth change concept name and summary after generating a detailed brief', () => {
  const approved = source({ kind: 'pr', ref: '42' }, baseline);
  approved.preview.title = 'Update staleRoute in src/routes.ts';
  const high = { ...approved, cacheKey: 'high', request: { ...approved.request, depth: 'high' as const } };
  const plain = { ...change, conceptTitle: 'Checking routes before using them', summary: 'The service removes outdated routes.',
    recommendation: { key: null, reason: 'See how the service keeps its routes current.' } };
  const first = persistGeneration(db, high, plain);
  const technical = 'The new check in src/routes.ts removes expired routes.';
  const low = { ...approved, cacheKey: 'low', request: { ...approved.request, depth: 'low' as const } };
  const detailed = persistGeneration(db, low, { ...change, summary: technical });
  if (first.kind !== 'change' || detailed.kind !== 'change') throw new Error('Expected change briefs.');
  expect(detailed.brief).toMatchObject({ conceptId: first.brief.conceptId, summary: technical });
  const graph = readWorkspaceGraph(db, workspaceId, true);
  expect(graph.concepts.find(concept => concept.id === first.brief.conceptId))
    .toMatchObject({ title: plain.conceptTitle, summary: plain.summary });
  expect(graph.changeSuggestions?.high).toMatchObject({ title: plain.conceptTitle, sourceTitle: approved.preview.title });
});

const affected = { key: 'pending-data', title: 'Keeping unconfirmed data', summary: 'Keep recently sent data until acknowledged.', portable: false };
const details = { key: 'retry-policy', title: 'Deciding when to retry', summary: 'Wait before retrying.', portable: false };
const stableChange = { ...change, conceptTitle: affected.title, overviewConceptKey: affected.key,
    concepts: [affected, details], touched: [affected.key, details.key],
    edges: [{ concept: affected.key, prerequisite: details.key }], recommendation: { key: affected.key, reason: 'Start here.' } };

function explain(input: typeof affected) {
  return { ...change, concepts: [input], edges: [], touched: [input.key], recommendation: { key: input.key, reason: 'Start here.' } };
}

it('keeps an alias contradiction separate from a verified scoped key on regeneration', () => {
  const input = { key: 'tcp', title: 'TCP', summary: 'Messages arrive in order.', portable: true };
  const approved = source({ kind: 'pr', ref: '42' }, previous);
  const saved = persistGeneration(db, approved, explain(input));
  if (saved.kind !== 'change') throw new Error('Expected a saved change.');
  const id = saved.brief.touched[0]!.id;
  recordEvidence(db, { workspaceId, conceptId: id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
  const conflict = explain({ ...input, title: 'HTTP' });
  const regenerated = persistGeneration(db, { ...approved, cacheKey: 'conflict' }, conflict);
  if (regenerated.kind !== 'change') throw new Error('Expected a regenerated change.');
  const other = regenerated.brief.touched[0]!.id;
  expect(other).not.toBe(id);
  expect(persistGeneration(db, { ...approved, cacheKey: 'conflict-again' }, conflict)).toMatchObject({ brief: { touched: [{ id: other }] } });
  expect(persistGeneration(db, { ...approved, cacheKey: 'correct-again' }, explain(input))).toMatchObject({ brief: { touched: [{ id }] } });
  const { concepts } = getGlobalKnowledgeGraph(db);
  expect(concepts.find(concept => concept.id === id)?.masteredDepth).toBe('medium');
  expect(concepts.find(concept => concept.id === other)?.masteredDepth).toBeNull();
});

it('keeps a generic title from lending its key to conflicting recognized aliases', () => {
  const input = { key: 'transport', title: 'Transport', summary: 'Messages arrive in order.', portable: true };
  const approved = source({ kind: 'pr', ref: '42' }, previous);
  const generate = (title: string) => {
    const result = persistGeneration(db, { ...approved, cacheKey: title }, explain({ ...input, title }));
    if (result.kind !== 'change') throw new Error('Expected a saved change.');
    return result.brief.touched[0]!.id;
  };
  const generic = generate('Transport');
  const tcp = generate('TCP');
  expect(tcp).not.toBe(generic);
  recordEvidence(db, { workspaceId, conceptId: tcp, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
  const http = generate('HTTP');
  expect(new Set([generic, tcp, http]).size).toBe(3);
  const again = persistGeneration(db, { ...approved, cacheKey: 'tcp-again' }, explain({ ...input, title: 'TCP' }));
  expect(again).toMatchObject({ brief: { touched: [{ id: tcp }] } });
  const { concepts } = getGlobalKnowledgeGraph(db);
  expect(concepts.find(concept => concept.id === tcp)?.masteredDepth).toBe('medium');
  expect(concepts.find(concept => concept.id === http)?.masteredDepth).toBeNull();
});

it('does not bind a foundation to a verified footprint with conflicting aliases', () => {
  const input = { key: 'transport', title: 'TCP', summary: 'Messages arrive in order.', portable: true };
  const learned = upsertConcept(db, { ...input, workspaceId });
  recordEvidence(db, { workspaceId, conceptId: learned.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
  const approved = source({ kind: 'pr', ref: '42' }, previous);
  const result = persistGeneration(db, approved, changeReply.parse({ ...explain(input), foundations: [
    { key: input.key, summary: input.summary, title: 'HTTP', why: 'This determines when to read the next message.',
      probe: { type: 'check', kind: 'prediction', prompt: 'What arrives first?', options: ['One', 'Two', 'Three', 'Four'], expected: 0 },
      practice: { type: 'check', kind: 'prediction', prompt: 'What arrives next?', options: ['One', 'Two', 'Three', 'Four'], expected: 1 } },
  ] }));
  if (result.kind !== 'change') throw new Error('Expected a saved change.');
  expect(result.brief.touched).toMatchObject([{ id: learned.id }]);
  expect(readLesson(db, { workspaceId, conceptId: result.brief.conceptId, depth: 'medium', lessonId: result.brief.lessonId }))
    .toMatchObject({ foundation: { title: 'HTTP', phase: 'probe' } });
  const { concepts } = getGlobalKnowledgeGraph(db);
  expect(concepts.find(concept => concept.title === 'HTTP')?.masteredDepth).toBeNull();
});

function foundationFor(input: { key: string; summary: string }, title: string) {
  const check = (prompt: string, expected: number) => ({ type: 'check', kind: 'prediction', prompt, options: ['One', 'Two', 'Three', 'Four'], expected });
  return { key: input.key, summary: input.summary, title, why: 'This determines when to read the next message.',
    probe: check('What arrives first?', 0), practice: check('What arrives next?', 1) };
}

function openFoundation(approved: ApprovedSource, input: typeof affected, foundationTitle: string) {
  const result = persistGeneration(db, approved, changeReply.parse({ ...explain(input), foundations: [foundationFor(input, foundationTitle)] }));
  if (result.kind !== 'change') throw new Error('Expected a saved change.');
  const address = { workspaceId, conceptId: result.brief.conceptId, depth: 'medium' as const, lessonId: result.brief.lessonId };
  return { result, address, foundation: readLesson(db, address).foundation };
}

it('judges an unlabelled footprint’s foundation by its own proof, not a related verified concept', () => {
  const input = { key: 'transport', title: 'Transport', summary: 'Messages arrive in order.', portable: true };
  const tcp = upsertConcept(db, { ...input, title: 'TCP', workspaceId });
  recordEvidence(db, { workspaceId, conceptId: tcp.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
  const { result, foundation } = openFoundation(source({ kind: 'pr', ref: '42' }, previous), input, 'HTTP');
  expect(result.brief.touched).toMatchObject([{ id: tcp.id }]);
  expect(foundation).toMatchObject({ title: 'HTTP', phase: 'probe' });
  const { concepts } = getGlobalKnowledgeGraph(db);
  expect(concepts.find(concept => concept.title === 'HTTP')?.masteredDepth).toBeNull();
  expect(concepts.find(concept => concept.id === tcp.id)?.masteredDepth).toBe('medium');
});

it('never repeats an answered probe when a corroborated foundation drops its label', () => {
  const input = { key: 'transport', title: 'TCP', summary: 'Messages arrive in order.', portable: false };
  const approved = source({ kind: 'pr', ref: '42' }, previous);
  const plain = persistGeneration(db, { ...approved, cacheKey: 'plain' }, explain(input));
  if (plain.kind !== 'change') throw new Error('Expected a saved change.');
  const tcp = plain.brief.touched[0]!.id;
  const first = openFoundation(approved, input, 'TCP');
  expect(first.result.brief.touched).toMatchObject([{ id: tcp }]);
  expect(first.foundation).toMatchObject({ title: 'TCP', phase: 'probe' });
  const answer = { ...first.address, decision: { revision: first.foundation!.revision, answer: 1 } };
  expect(readerHandlers(db)['reader:foundation'](answer).step).toMatchObject({ title: 'TCP', phase: 'practice' });
  const count = getGlobalKnowledgeGraph(db).concepts.length;
  const again = openFoundation({ ...approved, cacheKey: 'label-free' }, input, 'Ordered delivery');
  expect(again.result.brief.touched).toMatchObject([{ id: tcp }]);
  expect(again.foundation).toMatchObject({ title: 'Ordered delivery', phase: 'practice' });
  expect(getGlobalKnowledgeGraph(db).concepts).toHaveLength(count);
});

it('reuses a compatible portable key alias from another workspace', () => {
  const input = { key: 'tcp', title: 'TCP', summary: 'Messages arrive in order.', portable: true };
  const learned = upsertConcept(db, { ...input, workspaceId });
  recordEvidence(db, { workspaceId, conceptId: learned.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
  workspaceId = addWorkspace(db, { kind: 'github', owner: 'acme', repo: 'relay' }).id;
  const selection = { kind: 'pr', ref: '42' } as const;
  const approved = source(selection, previous);
  const alias = { ...input, key: 'transmission-control-protocol', title: 'Transmission Control Protocol' };
  expect(persistGeneration(db, approved, explain(alias))).toMatchObject({ brief: { touched: [{ id: learned.id }] } });
  expect(readWorkspaceGraph(db, workspaceId, true).concepts.filter(concept => concept.portable)).toMatchObject([{ id: learned.id }]);
  expect(getGlobalKnowledgeGraph(db).concepts.find(concept => concept.id === learned.id)?.masteredDepth).toBe('medium');
});

it('uses the same distinct trace labels in saved and pinned change views', () => {
  const approved = source({ kind: 'pr', ref: '42' }, previous);
  const original = ['Send the parcel', 'Check for a receipt', 'Send the parcel'];
  const trace = original.slice(0, 2);
  const result = persistGeneration(db, approved, { ...change, trace: original });
  if (result.kind !== 'change') throw new Error('Expected a saved change.');
  expect(result.brief.trace).toEqual(trace);
  const body = readLesson(db, { workspaceId, conceptId: result.brief.conceptId, depth: 'medium', lessonId: result.brief.lessonId });
  expect(body.blocks).toContainEqual(expect.objectContaining({ type: 'diagram', nodes: trace }));
  db.prepare('UPDATE repository_generations SET result = json_set(result, \'$.brief.trace\', json(?)) WHERE cache_key = ?')
    .run(JSON.stringify(original), approved.cacheKey);
  expect(cachedGeneration(db, approved.cacheKey)).toMatchObject({ brief: { trace } });
  expect(latestBrief(db, { workspaceId, kind: 'pr', ref: '42', provider: 'codex', depth: 'medium' })?.trace).toEqual(trace);
});

describe('corroborated change concept identities', () => {
  const proposal = stableChange;
  it.each([true, false])('keeps a footprint and its depth evidence when portability flips (portable first: %s)', portable => {
    const approved = source({ kind: 'pr', ref: '42' }, previous);
    const first = { ...approved, request: { ...approved.request, depth: portable ? 'high' as const : 'low' as const } };
    const second = { ...approved, cacheKey: 'other-depth', request: { ...approved.request, depth: portable ? 'low' as const : 'high' as const } };
    const input = { ...details, portable };
    const initial = persistGeneration(db, first, { ...proposal, overviewConceptKey: null, concepts: [input], touched: [input.key], edges: [],
      recommendation: { key: input.key, reason: 'Review the retry policy.' } });
    if (initial.kind !== 'change') throw new Error('Expected a change brief.');
    const id = initial.brief.recommendation.conceptId;
    recordEvidence(db, { workspaceId, conceptId: id, depth: first.request.depth, status: 'demonstrated',
      source: 'check', masteryVerified: true });
    expect(persistGeneration(db, second, { ...proposal, overviewConceptKey: null, concepts: [{ ...input, portable: !portable }], touched: [input.key],
      edges: [], recommendation: { key: input.key, reason: 'Review the retry policy.' },
    })).toMatchObject({ brief: { touched: [{ id }] } });
    const graph = getGlobalKnowledgeGraph(db);
    expect(graph.concepts).toHaveLength(2);
    expect(graph.concepts).toContainEqual(expect.objectContaining({ id, masteredDepth: first.request.depth }));
    expect(readWorkspaceGraph(db, workspaceId, true).evidence).toMatchObject([{ conceptId: id, depth: first.request.depth }]);
  });

  it('retains an exact mapped portable key when its title and portability change', () => {
    const input = { key: 'tcp', title: 'Transmission Control Protocol',
      summary: 'An ordered stream of bytes.', portable: true };
    const tcp = upsertConcept(db, { ...input, key: 'tcp', workspaceId });
    const approved = source({ kind: 'pr', ref: '42' }, previous);
    const first = { ...proposal, overviewConceptKey: null, concepts: [input], edges: [], touched: [input.key],
      recommendation: { key: input.key, reason: 'Review the transport.' } };
    expect(persistGeneration(db, approved, first)).toMatchObject({ brief: { touched: [{ id: tcp.id }] } });
    const next = { ...approved, cacheKey: 'deeper', request: { ...approved.request, depth: 'low' as const } };
    expect(persistGeneration(db, next, { ...first, concepts: [{ ...input, key: 'tcp', title: 'TCP', portable: false }],
      touched: ['tcp'], recommendation: { ...first.recommendation, key: 'tcp' } })).toMatchObject({ brief: { touched: [{ id: tcp.id }] } });
    expect(getGlobalKnowledgeGraph(db).concepts).toHaveLength(2);
    expect(readWorkspaceGraph(db, workspaceId).concepts).toMatchObject([{ id: tcp.id, key: tcp.key, portable: true }]);
  });

  it('keeps a new same-title footprint separate when the overview teaches a different idea', () => {
    const approved = source({ kind: 'pr', ref: '42' }, previous);
    const high = { ...approved, request: { ...approved.request, depth: 'high' as const } };
    const result = persistGeneration(db, high, { ...proposal, overviewConceptKey: undefined,
      summary: 'A delivery is delayed while a task is still active.' });
    if (result.kind !== 'change') throw new Error('Expected a change brief.');
    expect(result.brief.touched[0]?.id).not.toBe(result.brief.conceptId);
    expect(getGlobalKnowledgeGraph(db).concepts).toHaveLength(3);
  });
});

it('does not reuse a scoped key whose meaning fails the description check', () => {
  const approved = source({ kind: 'pr', ref: '42' }, previous);
  const simple = { ...stableChange, overviewConceptKey: null, concepts: [details], touched: [details.key], edges: [],
    recommendation: { key: details.key, reason: 'Review the policy.' } };
  const initial = persistGeneration(db, approved, simple);
  if (initial.kind !== 'change') throw new Error('Expected a change brief.');
  const oldId = initial.brief.recommendation.conceptId;
  recordEvidence(db, { workspaceId, conceptId: oldId, depth: 'low', status: 'demonstrated',
    source: 'check', masteryVerified: true });

  const conflict = { ...simple, concepts: [{ ...details, summary: 'Never retry a failed payment.' }] };
  const second = persistGeneration(db, { ...approved, cacheKey: 'conflicting' }, conflict);
  if (second.kind !== 'change') throw new Error('Expected a change brief.');
  const newId = second.brief.recommendation.conceptId;
  expect(newId).not.toBe(oldId);
  expect(persistGeneration(db, { ...approved, cacheKey: 'conflicting-again' }, conflict)).toMatchObject({ brief: { touched: [{ id: newId }] } });
  const concepts = getGlobalKnowledgeGraph(db).concepts;
  expect(concepts.find(c => c.id === oldId)?.masteredDepth).toBe('low');
  expect(concepts.find(c => c.id === newId)?.masteredDepth).toBeNull();
});

describe('stable change overview and footprint', () => {
  const proposal = stableChange;
  const { title } = affected;
  it('upserts a PR overview and its footprint when regenerated at the same depth and across depths', () => {
    const approved = source({ kind: 'pr', ref: '42' }, previous);
    const high = { ...approved, request: { ...approved.request, depth: 'high' as const } };
    const first = persistGeneration(db, high, proposal);
    if (first.kind !== 'change') throw new Error('Expected a change brief.');
    const { conceptId, touched } = first.brief;
    expect(touched).toMatchObject([{ id: conceptId, title }, { title: details.title }]);
    recordEvidence(db, { workspaceId, conceptId, depth: 'high', status: 'demonstrated', source: 'check', masteryVerified: true });

    const alternate = { ...high, cacheKey: 'regenerated', preview: { ...high.preview, model: 'another-model' } };
    const regenerated = persistGeneration(db, alternate, { ...proposal, concepts: [
      { ...affected, title: 'Saving data for later' }, { ...details, title: 'Trying again' },
    ] });
    const low = { ...approved, cacheKey: 'deeper', request: { ...approved.request, depth: 'low' as const } };
    const deeper = persistGeneration(db, low, { ...proposal, conceptTitle: null,
      concepts: [{ ...affected, title: 'Retaining pending segments' }, { ...details, title: 'Retry deadline' }],
      mechanics: 'Deeper lesson mechanics.' });
    expect(regenerated).toMatchObject({ brief: { conceptId, touched } });
    expect(deeper).toMatchObject({ brief: { conceptId, touched } });
    expect(getGlobalKnowledgeGraph(db).concepts.map(concept => concept.title)).toEqual([title, details.title]);
    expect(readLesson(db, { workspaceId, conceptId, depth: 'high' }).mastery.stage).toBe('understood');
    const lowLesson = readLesson(db, { workspaceId, conceptId, depth: 'low' });
    expect(lowLesson.mastery.stage).toBe('teaching');
    expect(lowLesson.blocks).toContainEqual(expect.objectContaining({ text: 'Deeper lesson mechanics.' }));
  });

  it('retains the mastery of a low-first footprint when a later reply claims an established overview', () => {
    const approved = source({ kind: 'pr', ref: '42' }, previous);
    const low = { ...approved, request: { ...approved.request, depth: 'low' as const } };
    const first = persistGeneration(db, low, { ...proposal, conceptTitle: null, overviewConceptKey: null });
    if (first.kind !== 'change') throw new Error('Expected a change brief.');
    const prior = first.brief.recommendation.conceptId;
    expect(prior).not.toBe(first.brief.conceptId);
    recordEvidence(db, { workspaceId, conceptId: prior, depth: 'low', status: 'demonstrated', source: 'check', masteryVerified: true });

    const high = { ...approved, cacheKey: 'high-after-low', request: { ...approved.request, depth: 'high' as const } };
    const { conceptId } = first.brief;
    expect(persistGeneration(db, high, proposal)).toMatchObject({ brief: { conceptId } });
    expect(cachedGeneration(db, low.cacheKey)).toMatchObject({ brief: { conceptId, recommendation: { conceptId: prior } } });
    expect(getGlobalKnowledgeGraph(db).concepts.find(c => c.id === prior)?.masteredDepth).toBe('low');
    expect(readLesson(db, { workspaceId, conceptId, depth: 'low' }).mastery.stage).toBe('teaching');
    expect(readLesson(db, { workspaceId, conceptId, depth: 'high' }).mastery.stage).toBe('teaching');
  });
});

it('keeps different scoped aliases separate even when the rendered title and description match', () => {
  const approved = source({ kind: 'pr', ref: '42' }, previous);
  const input = { key: 'tcp', title: 'Protocol boundary', summary: 'Establishes how the peers communicate.', portable: false };
  const explain = (key: string) => ({ ...stableChange, overviewConceptKey: null, concepts: [{ ...input, key }], edges: [],
    touched: [key], recommendation: { key, reason: 'Review the protocol boundary.' } });
  const first = persistGeneration(db, approved, explain('tcp'));
  const second = persistGeneration(db, { ...approved, cacheKey: 'second-protocol' }, explain('http'));
  if (first.kind !== 'change' || second.kind !== 'change') throw new Error('Expected change briefs.');
  expect(second.brief.touched[0]?.id).not.toBe(first.brief.touched[0]?.id);
  expect(getGlobalKnowledgeGraph(db).concepts).toHaveLength(3);
});

it('plans local usage in a new repository and only tops up the missing portable depth', () => {
  const first = workspaceId;
  const map = (key: string, title: string, usage: string) => baselineReply.parse({
    schema: 'delve.map/1',
    concepts: [{ key: 'logging', title: 'Service logs', summary: 'Where the service writes logs.', portable: false },
      { key, title, summary: 'A reliable ordered byte stream.', portable: true },
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
  const usage = graph.concepts.find(c => c.key.endsWith('/worker-lease-transport'))!;
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
  const deeperUsage = prepareTurn(db, { ...preview, conceptId: usage.id, depth: 'low' }).preview.prompt;
  expect(deeperUsage).toContain('cover only the additional detail needed at low depth');
  expect(deeperUsage).not.toContain('medium depth; teach only how this repository uses it.');
  expect(prepareTurn(db, { ...preview, conceptId: tcp.id, depth: 'low' }).preview.prompt)
    .toContain('Teach and check only the additional detail needed at low depth.');
});

it('opens a saved change with the current global evidence and teaches its repository usage', () => {
  const selection = { kind: 'pr', ref: '19' } as const;
  const selected = source(selection, previous);
  const reply = { ...change, recommendation: { key: 'nginx/proxy', reason: 'Learn about proxies.' } };
  const result = persistGeneration(db, selected, reply);
  if (result.kind !== 'change') throw new Error('Expected a change brief');
  const proxy = result.brief.recommendation.conceptId;
  const origin = addWorkspace(db, { kind: 'git', path: '/upstream' });
  recordEvidence(db, { workspaceId: origin.id, conceptId: proxy, depth: 'medium', status: 'demonstrated',
    source: 'check', masteryVerified: true });
  const brief = latestBrief(db, { ...selection, workspaceId, depth: 'medium', provider: 'codex' });
  expect(brief?.recommendation.conceptId).toBe(result.brief.conceptId);
  expect(brief?.what).toEqual(result.brief.what);
  expect(useCachedGeneration(db, selected)).toEqual({ kind: 'change', brief });
  const preview = { workspaceId, provider: 'codex', intent: { kind: 'teach' }, depth: 'medium' } as const;
  for (const conceptId of [result.brief.conceptId, ...result.brief.touched.filter(c => c.id !== proxy).map(c => c.id)]) {
    expect(prepareTurn(db, { ...preview, conceptId }).preview.prompt)
      .toContain('The learner already understands Proxy at medium depth; teach only how this repository uses it.');
  }
});

it('restores the original saved recommendation after portable evidence is reset', () => {
  const selection = { kind: 'pr', ref: '20' } as const;
  const selected = source(selection, previous);
  const proxy = upsertConcept(db, { workspaceId, portable: true, key: 'nginx/proxy', title: 'Proxy', summary: 'Forwards requests' });
  recordEvidence(db, { workspaceId, conceptId: proxy.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
  const reply = { ...change, recommendation: { key: proxy.key, reason: 'Learn about proxies.' } };
  const result = persistGeneration(db, selected, reply);
  if (result.kind !== 'change') throw new Error('Expected a change brief');
  expect(result.brief.recommendation.conceptId).toBe(result.brief.conceptId);
  resetEvidence(db, proxy.id, { workspaceId, depth: 'medium' });
  const reopened = latestBrief(db, { ...selection, workspaceId, depth: 'medium', provider: 'codex' });
  expect(reopened?.recommendation).toEqual({ conceptId: proxy.id, reason: 'Learn about proxies.', title: 'Proxy' });
  expect(useCachedGeneration(db, selected)).toEqual({ kind: 'change', brief: reopened });
});

it('suggests the PR usage in Atlas only while current portable evidence covers the selected depth', () => {
  const selection = { kind: 'pr', ref: '21' } as const;
  persistGeneration(db, source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline), mapped);
  const selected = source(selection, previous);
  const reply = { ...change, recommendation: { key: 'nginx/proxy', reason: 'Learn about proxies.' } };
  const result = persistGeneration(db, selected, reply);
  if (result.kind !== 'change') throw new Error('Expected a change brief');
  const proxy = result.brief.recommendation.conceptId;
  const origin = addWorkspace(db, { kind: 'git', path: '/upstream' });
  const graph = () => readWorkspaceGraph(db, workspaceId);
  const address = { ...selection, workspaceId, depth: 'medium', provider: 'codex' } as const;
  const before = graph();
  expect(before.changeSuggestions?.medium).toBeUndefined();
  expect(before.suggestions?.medium).toEqual({ conceptId: proxy, reason: reply.recommendation.reason });
  const prove = (depth: 'high' | 'low') => recordEvidence(db, { workspaceId: origin.id, conceptId: proxy, depth,
    status: 'demonstrated', source: 'check', masteryVerified: true });
  prove('high');
  expect(graph().changeSuggestions?.medium).toBeUndefined();
  prove('low');
  const live = latestBrief(db, address)?.recommendation;
  expect(live?.conceptId).toBe(result.brief.conceptId);
  expect(graph().changeSuggestions?.medium).toEqual({ ...selection, reason: live?.reason, title: result.brief.title });
  expect(graph().suggestions?.medium?.conceptId).toBe(before.concepts.find(c => !c.portable)?.id);
  expect(resetEvidence(db, proxy, { workspaceId: origin.id, depth: 'low' })).toBe(1);
  expect(graph().changeSuggestions?.medium).toBeUndefined();
  expect(graph().suggestions?.medium).toEqual(before.suggestions?.medium);
  expect(latestBrief(db, address)?.recommendation).toEqual(result.brief.recommendation);
});

it('recommends the missing prerequisite of the linked usage before an unrelated ready concept', () => {
  const portable = upsertConcept(db, { workspaceId, portable: true, key: 'nginx/proxy', title: 'Proxy', summary: 'Forwards requests' });
  recordEvidence(db, { workspaceId, conceptId: portable.id, depth: 'medium', status: 'demonstrated',
    source: 'check', masteryVerified: true });
  const proposal = { ...mapped, concepts: [
    { key: 'log-format', title: 'Log format', summary: 'A project rule.', portable: false },
    ...mapped.concepts,
    { key: 'http', title: 'HTTP', summary: 'A request and response protocol.', portable: true },
  ], edges: [...mapped.edges, { concept: 'web/route', prerequisite: 'http' }],
  recommendation: { key: 'nginx/proxy', reason: 'Study the proxy first.' } };
  persistGeneration(db, source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline), proposal);
  persistGeneration(db, source({ kind: 'baseline', commit: previous, paths: ['src/ports.ts'] }, previous),
    { ...mapped, recommendation: proposal.recommendation });
  const graph = readWorkspaceGraph(db, workspaceId);
  expect(graph.suggestions?.medium?.conceptId).toBe(graph.concepts.find(c => c.key === 'http')?.id);
});

describe('atomic repository generation', () => {
  it('preserves canonical portable knowledge at its demonstrated depth and binds both concepts to the approved commit', () => {
    const prior = addWorkspace(db, { kind: 'topic', title: 'Reverse proxies' });
    const portable = upsertConcept(db, { workspaceId: prior.id, portable: true, key: 'nginx/proxy', title: 'NGINX reverse proxy', summary: 'Forwards requests' });
    recordEvidence(db, { workspaceId: prior.id, conceptId: portable.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
    const selected = source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline);
    persistGeneration(db, selected, mapped);
    expect(persistGeneration(db, selected, mapped)).toEqual({ kind: 'baseline' });
    const graph = readWorkspaceGraph(db, workspaceId);
    expect(graph.concepts).toHaveLength(2);
    expect(graph.concepts).toContainEqual(expect.objectContaining({ id: portable.id, title: 'NGINX reverse proxy', summary: 'Forwards requests' }));
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
    expect(result.brief.touched.map(c => c.title)).toEqual(['PR title', 'New feature']);
    expect(result.brief.touched[0]?.id).not.toBe(reviewed.concepts.find(c => !c.portable)?.id);
    expect(readWorkspaceGraph(db, workspaceId, true).concepts).toHaveLength(6);
    expect(readLesson(db, { workspaceId, conceptId: result.brief.conceptId, depth: 'medium' }).source).toBe(previous);
  });

});

it('keeps a conflicting meaning of a portable title local without inherited evidence or coverage', () => {
  const origin = workspaceId;
  const selected = () => source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline);
  const proposal = (key: string, title: string, summary: string) => baselineReply.parse({ schema: 'delve.map/1',
    concepts: [{ key, title, summary, portable: true }], edges: [], recommendation: { key, reason: 'Start here.' } });
  persistGeneration(db, selected(), proposal('tcp', 'TCP', 'A reliable ordered byte stream'));
  const tcp = readWorkspaceGraph(db, origin).concepts[0]!;
  recordEvidence(db, { workspaceId: origin, conceptId: tcp.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
  workspaceId = addWorkspace(db, { kind: 'github', owner: 'acme', repo: 'other' }).id;
  persistGeneration(db, selected(), proposal('tcp', 'TCP', 'A tropical climate policy for farmers'));
  const graph = readWorkspaceGraph(db, workspaceId);
  expect(graph.concepts).toMatchObject([{ title: 'TCP', portable: false }]);
  expect(graph.concepts[0]!.id).not.toBe(tcp.id);
  expect(graph.evidence).toEqual([]);
  expect(readWorkspaceCoverage(db).find(item => item.workspaceId === workspaceId)).toMatchObject({ total: 1 });
  expect(readLesson(db, { workspaceId, conceptId: graph.concepts[0]!.id, depth: 'medium' }).reused).toBe(false);
});

it('requires more than a matching title and summary for an unrecognized alias', () => {
  const existing = upsertConcept(db, { key: 'packet-framing', title: 'Framing', summary: 'Divides a stream into messages.', portable: true });
  const key = 'other-framing';
  const proposal = baselineReply.parse({ schema: 'delve.map/1', concepts: [
    { key, title: existing.title, summary: existing.summary, portable: true },
  ], edges: [], recommendation: { key, reason: 'Study message boundaries.' } });
  persistGeneration(db, source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline), proposal);
  const graph = readWorkspaceGraph(db, workspaceId);
  expect(graph.concepts).toMatchObject([{ title: existing.title, portable: false }]);
  expect(graph.concepts[0]!.id).not.toBe(existing.id);
});

it('uses the provider key to corroborate a familiar portable title', () => {
  const learned = upsertConcept(db, { key: 'tcp', title: 'TCP', summary: 'A reliable byte stream.', portable: true });
  const origin = addWorkspace(db, { kind: 'topic', title: 'Byte streams' });
  recordEvidence(db, { workspaceId: origin.id, conceptId: learned.id, depth: 'high', status: 'demonstrated', source: 'check', masteryVerified: true });
  const input = { key: 'other-protocol', title: learned.title, summary: learned.summary, portable: true };
  const proposal = baselineReply.parse({ schema: 'delve.map/1', concepts: [input], edges: [],
    recommendation: { key: input.key, reason: 'Study this protocol.' } });
  persistGeneration(db, source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline), proposal);
  const graph = readWorkspaceGraph(db, workspaceId);
  expect(graph.concepts[0]?.id).not.toBe(learned.id);
  expect(graph.evidence).toEqual([]);
});

it.each([
  { key: 'tcp', linked: false, portable: true },
  { key: 'tcp', linked: true, portable: false },
  { key: 'transport', linked: false, portable: true },
  { key: 'transport', linked: true, portable: false },
])(
  'scopes disagreeing known aliases (key=$key, migrated link=$linked)', ({ key, linked, portable }) => {
    const origin = workspaceId;
    const summary = 'A reliable ordered byte stream.';
    const tcp = upsertConcept(db, { key, title: 'TCP', summary, portable: true, workspaceId: origin });
    recordEvidence(db, { workspaceId: origin, conceptId: tcp.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
    workspaceId = addWorkspace(db, { kind: 'git', path: '/transport' }).id;
    if (linked) {
      const legacy = upsertConcept(db, { key, title: 'TCP', summary, portable: false, workspaceId });
      db.prepare('INSERT INTO concept_identity_links VALUES (?, ?)').run(legacy.id, tcp.id);
      db.prepare('UPDATE workspace_concepts SET on_atlas = 0 WHERE concept_id = ?').run(legacy.id);
    }
    const conflicting = { key, title: 'HTTP', summary, portable };
    const proposal = baselineReply.parse({ schema: 'delve.map/1', concepts: [conflicting], edges: [],
      recommendation: { key: conflicting.key, reason: 'Start here.' } });
    const selected = source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline);
    persistGeneration(db, selected, proposal);
    const graph = readWorkspaceGraph(db, workspaceId);
    expect(graph.concepts).toMatchObject([{ title: 'HTTP', portable: false, key: expect.stringContaining(`ws/${workspaceId}/`) }]);
    const scoped = graph.concepts[0]!;
    expect(scoped.id).not.toBe(tcp.id);
    expect(graph.evidence).toEqual([]);
    expect(readLesson(db, { workspaceId, conceptId: scoped.id, depth: 'medium' }).reused).toBe(false);
    useCachedGeneration(db, selected);
    expect(readWorkspaceGraph(db, workspaceId).concepts).toEqual([scoped]);

    const next = source({ kind: 'baseline', commit: previous, paths: ['src/routes.ts'] }, previous);
    const corroborated = linked || key === 'transport' ? { ...conflicting, title: 'TCP' }
      : { key: 'transmission-control-protocol', title: 'Transmission Control Protocol', summary, portable: true };
    persistGeneration(db, next, baselineReply.parse({ ...proposal, concepts: linked || key === 'transport' ? [corroborated] : [conflicting, corroborated],
      recommendation: { ...proposal.recommendation, key: corroborated.key } }));
    expect(db.prepare('SELECT next_concept FROM repository_generations WHERE cache_key = ?').get(next.cacheKey)?.next_concept).toBe(tcp.id);
    expect(readWorkspaceGraph(db, workspaceId).concepts).toEqual(expect.arrayContaining([scoped,
      expect.objectContaining({ id: tcp.id, portable: true }),
    ]));
    expect(readWorkspaceGraph(db, workspaceId).evidence).toMatchObject([{ conceptId: tcp.id, workspaceId: origin }]);
  },
);

it.each([true, false])('keeps conflicting regenerated migrated concepts separate (portable=%s)', portable => {
  const summary = 'A collection that processes queued jobs in first in first out order.';
  const conflict = 'A collection that processes queued jobs in last in first out order.';
  const canonical = upsertConcept(db, { key: 'queues', title: 'Queue', summary, portable: true, workspaceId });
  const legacy = upsertConcept(db, { key: 'queue', title: 'Queue', summary, portable: false, workspaceId });
  db.prepare('INSERT INTO concept_identity_links (legacy_concept_id, canonical_concept_id) VALUES (?, ?)').run(legacy.id, canonical.id);
  recordEvidence(db, { workspaceId, conceptId: canonical.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
  const proposal = baselineReply.parse({ schema: 'delve.map/1', concepts: [{ key: 'queue', title: 'Queue', summary: conflict, portable }],
    edges: [], recommendation: { key: 'queue', reason: 'Study the queue.' } });
  persistGeneration(db, source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline), proposal);
  const graph = readWorkspaceGraph(db, workspaceId);
  const scoped = graph.concepts.find(concept => concept.summary === conflict)!;
  expect(scoped).toMatchObject({ portable: false, title: 'Queue' });
  expect(scoped.id).not.toBe(legacy.id);
  expect(graph.evidence.some(item => item.conceptId === scoped.id)).toBe(false);
  expect(db.prepare('SELECT summary FROM concepts WHERE id = ?').get(legacy.id)?.summary).toBe(summary);
  expect(readLesson(db, { workspaceId, conceptId: scoped.id, depth: 'medium' }).reused).toBe(false);
});

it('scopes portable dependents of an ambiguous prerequisite and preserves the edges', () => {
  upsertConcept(db, { key: 'queue', title: 'Queue', summary: 'First in first out ordering', portable: true, workspaceId });
  const proposal = baselineReply.parse({ schema: 'delve.map/1', concepts: [
    { key: 'queue', title: 'Queue', summary: 'Last in first out ordering', portable: true },
    { key: 'dependent', title: 'Consumer', summary: 'Consumes queued jobs', portable: true },
    { key: 'top', title: 'Pipeline', summary: 'Processes queued jobs', portable: true },
  ], edges: [{ concept: 'dependent', prerequisite: 'queue' }, { concept: 'top', prerequisite: 'dependent' }],
  recommendation: { key: 'queue', reason: 'Start here.' } });
  persistGeneration(db, source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline), proposal);
  const graph = readWorkspaceGraph(db, workspaceId);
  const ids = Object.fromEntries(graph.concepts.filter(concept => !concept.portable).map(concept => [concept.title, concept.id]));
  expect(Object.keys(ids)).toEqual(expect.arrayContaining(['Queue', 'Consumer', 'Pipeline']));
  expect(graph.edges).toEqual(expect.arrayContaining([
    { conceptId: ids.Consumer, prerequisiteId: ids.Queue }, { conceptId: ids.Pipeline, prerequisiteId: ids.Consumer },
  ]));
});

it.each([true, false])('replays compatible aliases as one local identity (both aliases declare the prerequisite: %s)', both => {
  const concepts = [
    { key: 'queue', title: 'Queue', summary: 'Jobs wait in first in first out order.', portable: true },
    { key: 'queues', title: 'Queues', summary: 'JOBS wait in first in first out order.', portable: true },
    { key: 'dispatch', title: 'Local dispatcher', summary: 'Dispatches this repository’s jobs.', portable: false },
  ];
  const prerequisite = 'dispatch';
  const proposal = baselineReply.parse({ schema: 'delve.map/1', concepts,
    edges: [{ concept: 'queue', prerequisite }, ...(both ? [{ concept: 'queues', prerequisite }] : [])],
    recommendation: { key: 'queues', reason: 'Start here.' } });
  const first = source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline);
  const second = source({ kind: 'baseline', commit: previous, paths: ['src/routes.ts'] }, previous);
  persistGeneration(db, first, proposal);
  const original = readWorkspaceGraph(db, workspaceId);
  const scoped = original.concepts.find(c => c.title === 'Queue')!;
  const exposedKey = scoped.key.slice(`ws/${workspaceId}/`.length);
  const secondMap = { ...proposal, concepts: [...concepts.slice(1), { ...concepts[0]!, key: exposedKey, portable: false }],
    edges: [{ concept: 'queues', prerequisite }], recommendation: { key: exposedKey, reason: 'Start with the mapped concept.' } };
  persistGeneration(db, second, secondMap);
  expect(useCachedGeneration(db, first)).toEqual({ kind: 'baseline' });

  const replayed = readWorkspaceGraph(db, workspaceId);
  const queues = replayed.concepts.find(c => c.title === 'Queue')!;
  const dispatch = replayed.concepts.find(c => c.title === 'Local dispatcher')!;
  expect(replayed.concepts).toEqual(original.concepts);
  expect(replayed.concepts).toHaveLength(2);
  expect(queues.portable).toBe(false);
  expect(replayed.edges).toEqual([{ conceptId: queues.id, prerequisiteId: dispatch.id }]);
  expect(replayed.suggestions).toEqual(original.suggestions);
  expect(db.prepare('SELECT next_concept FROM repository_generations WHERE cache_key = ?').get(first.cacheKey)?.next_concept).toBe(queues.id);
});

it('replays a scoped change concept against its own commit after another brief touches the same meaning', () => {
  const title = 'TCP';
  const summary = 'A tropical climate policy for farmers.';
  upsertConcept(db, { key: 'tcp', title, summary: 'A network byte stream.', portable: true, workspaceId });
  const proposal = { ...change, concepts: [{ key: 'tcp', title, summary, portable: true }], edges: [],
    touched: ['tcp'], recommendation: { key: 'tcp', reason: 'Study this change.' } };
  const first = source({ kind: 'commit', ref: baseline }, baseline);
  const second = source({ kind: 'commit', ref: previous }, previous);
  const saved = persistGeneration(db, first, proposal);
  const next = persistGeneration(db, second, proposal);
  if (saved.kind !== 'change' || next.kind !== 'change') throw new Error('Expected saved briefs');
  const lesson = (conceptId: number) => readLesson(db, { workspaceId, conceptId, depth: 'medium' });
  expect(lesson(saved.brief.recommendation.conceptId).source).toBe(baseline);
  const replay = useCachedGeneration(db, first);
  if (replay?.kind !== 'change') throw new Error('Expected replayed brief');
  const firstId = replay.brief.recommendation.conceptId;
  const secondId = next.brief.recommendation.conceptId;
  expect(replay.brief.touched).toEqual([{ id: firstId, title }]);
  expect(lesson(secondId).source).toBe(previous);
  expect(lesson(firstId).source).toBe(baseline);
  expect(firstId).not.toBe(secondId);
  expect(latestBrief(db, { workspaceId, kind: 'commit', ref: baseline, depth: 'medium', provider: 'codex' })).toEqual(replay.brief);
});

it.each([true, false])('resolves aliases within one proposal consistently on cache replay (compatible=%s)', compatible => {
  const fifo = 'A collection processes jobs in first in first out order.';
  const second = compatible ? fifo : 'A collection processes jobs in last in first out order.';
  const proposal = baselineReply.parse({ schema: 'delve.map/1', concepts: [
    { key: 'queue', title: 'Queue', summary: fifo, portable: true },
    { key: 'queues', title: compatible ? 'Queue' : 'Queues', summary: second, portable: true },
  ], edges: [], recommendation: { key: 'queues', reason: 'Study the queue.' } });
  const selected = source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline);
  persistGeneration(db, selected, proposal);
  const before = readWorkspaceGraph(db, workspaceId);
  expect(before.concepts).toHaveLength(compatible ? 1 : 2);
  expect(before.concepts.filter(item => item.portable)).toMatchObject([{ summary: fifo }]);
  if (!compatible) expect(before.concepts).toContainEqual(expect.objectContaining({ summary: second, portable: false }));
  useCachedGeneration(db, selected);
  const after = readWorkspaceGraph(db, workspaceId);
  expect(after.concepts).toEqual(before.concepts);
  expect(after.suggestions).toEqual(before.suggestions);
});

it('does not overwrite an unrelated local at an internally allocated key', () => {
  const original = 'A reliable ordered byte stream';
  const input = { key: 'tcp', title: 'TCP', summary: 'A tropical climate policy for farmers', portable: true };
  const internal = 'ambiguous/' + digest(['baseline', input.key, input.summary.toLowerCase(), 'tcp']);
  upsertConcept(db, { key: 'tcp', title: 'TCP', summary: original, portable: true, workspaceId });
  const occupied = upsertConcept(db, { key: internal, title: 'Unrelated', summary: 'Independent knowledge', portable: false, workspaceId });
  recordEvidence(db, { workspaceId, conceptId: occupied.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
  const selected = source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline);
  const proposal = baselineReply.parse({ schema: 'delve.map/1', concepts: [input], edges: [], recommendation: { key: 'tcp', reason: 'Study.' } });
  persistGeneration(db, selected, proposal);
  const graph = readWorkspaceGraph(db, workspaceId);
  const local = graph.concepts.find(item => item.summary === input.summary)!;
  expect(local.id).not.toBe(occupied.id);
  expect(graph.evidence.some(item => item.conceptId === local.id)).toBe(false);
  expect(db.prepare('SELECT title,summary FROM concepts WHERE id = ?').get(occupied.id))
    .toEqual({ title: 'Unrelated', summary: 'Independent knowledge' });
  useCachedGeneration(db, selected);
  expect(readWorkspaceGraph(db, workspaceId).concepts.find(item => item.summary === input.summary)?.id).toBe(local.id);
});

it('reuses an unlinked local matching the proposal when its global identity conflicts', () => {
  upsertConcept(db, { key: 'tcp', title: 'TCP', summary: 'A network byte stream', portable: true, workspaceId });
  const local = upsertConcept(db, { key: 'tcp', title: 'TCP', summary: 'A climate policy for farmers', portable: false, workspaceId });
  recordEvidence(db, { workspaceId, conceptId: local.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
  const proposal = baselineReply.parse({ schema: 'delve.map/1', concepts: [
    { key: 'tcp', title: 'TCP', summary: local.summary, portable: true },
  ], edges: [], recommendation: { key: 'tcp', reason: 'Study.' } });
  persistGeneration(db, source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline), proposal);
  const graph = readWorkspaceGraph(db, workspaceId);
  expect(graph.concepts.filter(item => item.summary === local.summary)).toMatchObject([{ id: local.id }]);
  expect(graph.evidence).toContainEqual(expect.objectContaining({ conceptId: local.id }));
});

it('updates a pre-link cached recommendation to the replayed scoped identity', () => {
  const summary = 'A collection processes jobs in last in first out order.';
  const selected = source({ kind: 'baseline', commit: baseline, paths: ['src/routes.ts'] }, baseline);
  const proposal = baselineReply.parse({ schema: 'delve.map/1', concepts: [
    { key: 'queue', title: 'Queue', summary, portable: false },
  ], edges: [], recommendation: { key: 'queue', reason: 'Study.' } });
  persistGeneration(db, selected, proposal);
  const legacy = readWorkspaceGraph(db, workspaceId).concepts[0]!;
  const canonical = upsertConcept(db, { key: 'queues', title: 'Queue', summary: 'A collection processes jobs in first in first out order.',
    portable: true, workspaceId });
  db.prepare('INSERT INTO concept_identity_links (legacy_concept_id, canonical_concept_id) VALUES (?, ?)').run(legacy.id, canonical.id);
  useCachedGeneration(db, selected);
  const graph = readWorkspaceGraph(db, workspaceId);
  const local = graph.concepts.find(item => item.summary === summary && item.id !== legacy.id)!;
  expect(local).toMatchObject({ portable: false });
  expect(db.prepare('SELECT next_concept FROM repository_generations WHERE cache_key = ?').get(selected.cacheKey)?.next_concept).toBe(local.id);
  expect(graph.suggestions?.medium?.conceptId).toBe(local.id);
});
