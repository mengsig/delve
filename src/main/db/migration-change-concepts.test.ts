import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Depth } from '../../shared/domain';
import type { ChangeRef, RepoRequest } from '../../shared/repository';
import { cacheModel, selectModel } from '../providers/model';
import { readLesson, readerHandlers } from '../reader/ipc';
import { baselineReply } from '../repository/schemas';
import { cachedGeneration, digest, latestBrief, persistGeneration, useCachedGeneration, type ApprovedSource } from '../repository/store';
import { upsertConcept } from './concepts';
import { listEvidence, recordEvidence } from './evidence';
import { readWorkspaceGraph } from './graph';
import { getGlobalKnowledgeGraph } from './knowledge';
import { lessonRevision } from './lesson-selection';
import { bindSnapshot } from './lessons';
import { masteryScope } from './mastery-scope';
import { migrate, MIGRATIONS } from './migrations';
import { addWorkspace } from './workspaces';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const title = 'Keeping unconfirmed data';
const pull = { kind: 'pr', ref: '42' } as const;
const commit = { kind: 'commit', ref: head } as const;
const footprint = { key: 'pending-data', title, summary: 'Keep data until it is acknowledged.', portable: false };
let db: DatabaseSync;
let workspaceId: string;
let snapshotId: number;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  expect(migrate(db, MIGRATIONS.slice(0, 9))).toBe(9);
  workspaceId = addWorkspace(db, { kind: 'github', owner: 'acme', repo: 'web' }).id;
  snapshotId = bindSnapshot(db, workspaceId, head);
});
afterEach(() => db.close());

function createFootprint(input: typeof footprint, meaning: string[] = [input.key, input.summary.toLowerCase()]) {
  const fingerprint = digest(meaning);
  const concept = upsertConcept(db, { ...input, workspaceId, key: 'change/' + digest(['concept', snapshotId, fingerprint]) });
  db.prepare('INSERT INTO snapshot_concepts VALUES (?, ?)').run(snapshotId, concept.id);
  return concept.id;
}

function seedLesson(conceptId: number, cacheKey: string, provider: RepoRequest['provider'], depth: Depth) {
  const model = cacheModel(selectModel(provider).model);
  const body = JSON.stringify({ schema: 'delve.lesson/1', source: head, blocks: [
    { type: 'prose', heading: 'What changed', text: cacheKey }, { type: 'check', kind: 'prediction',
      prompt: 'What data do we keep?', options: ['Queued data', 'Expired data', 'Sent data', 'All data'], expected: 0 },
  ] });
  const id = Number(db.prepare(`INSERT INTO lessons (cache_key, schema_version, concept_id, workspace_id, snapshot_id, depth, provider, model, body, created_at)
    VALUES (?, 'delve.lesson/1', ?, ?, ?, ?, ?, ?, ?, '2026-01-01')`)
    .run(cacheKey, conceptId, workspaceId, snapshotId, depth, provider, model, body).lastInsertRowid);
  return { id, model, body };
}

function seedSavedChange(selection: ChangeRef, depth: Depth, cacheKey: string, affected: typeof footprint, touchedId: number,
  provider: 'codex' | 'claude' = 'codex') {
  const revision = digest([selection.kind, selection.ref, base, head, title, cacheKey]);
  const model = cacheModel(selectModel(provider).model);
  const overview = upsertConcept(db, { ...footprint, key: 'change/' + digest([revision, provider, selectModel(provider).model]), workspaceId });
  db.prepare('INSERT INTO snapshot_concepts VALUES (?, ?)').run(snapshotId, overview.id);
  const lesson = seedLesson(overview.id, cacheKey, provider, depth);
  const result = { kind: 'change', brief: { conceptId: overview.id, commit: head, base, title,
    trace: [], touched: [{ id: touchedId, title: affected.title }], recommendation: { conceptId: touchedId, title: affected.title, reason: 'Start here.' } } };
  db.prepare(`INSERT INTO repository_generations (cache_key, workspace_id, snapshot_id, kind, ref, depth, provider, model, schema_version,
    result, proposal, next_concept, reason, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'delve.change/1',
    ?, ?, ?, 'Start here.', '2026-01-01', (SELECT coalesce(max(last_used), 0) + 1 FROM repository_generations))`)
    .run(cacheKey, workspaceId, snapshotId, selection.kind, selection.ref, depth, provider, model,
      JSON.stringify(result), JSON.stringify({ concepts: [affected], touched: [affected.key] }), touchedId);
  return { ...lesson, conceptId: overview.id };
}

function regenerate(selection: ChangeRef, input: typeof footprint, depth: Depth = 'medium', prerequisite?: typeof footprint) {
  const source: ApprovedSource = { cacheKey: digest(['regenerated', selection, depth, input, prerequisite]), revision: head,
    request: { workspaceId, selection, depth, provider: 'codex' },
    preview: { ...selectModel('codex'), title, commit: head, base, bytes: 1, prompt: 'test', files: [], token: 'test', partial: false } };
  const concepts = prerequisite ? [input, prerequisite] : [input];
  const edges = prerequisite ? [{ concept: input.key, prerequisite: prerequisite.key }] : [];
  return persistGeneration(db, source, { schema: 'delve.change/1', concepts, edges,
    touched: [input.key], spans: [], summary: 'Review the changes.', what: 'The behavior changes.',
    why: 'This keeps data current.', before: 'The old behavior.', after: 'The new behavior.', trace: [], excerpt: [],
    mechanics: null, boundary: null, recommendation: { key: input.key, reason: 'Read about the change.' } });
}

it('keeps released footprints with the same key and title but conflicting descriptions separate through upgrade', () => {
  const dns = { ...footprint, key: 'cache', title: 'Caching', summary: 'Keep DNS responses until they expire.' };
  const page = { ...dns, summary: 'Keep a copy of rendered pages.' };
  const dnsId = createFootprint(dns);
  const pageId = createFootprint(page);
  seedSavedChange(pull, 'high', 'dns-brief', dns, dnsId);
  seedSavedChange(pull, 'low', 'page-brief', page, pageId);
  recordEvidence(db, { workspaceId, snapshotId, conceptId: pageId, depth: 'low',
    status: 'demonstrated', source: 'check', masteryVerified: true });

  migrate(db);
  const concepts = getGlobalKnowledgeGraph(db).concepts;
  expect(concepts.find(c => c.id === dnsId)?.masteredDepth).toBeNull();
  expect(concepts.find(c => c.id === pageId)?.masteredDepth).toBe('low');
  expect(regenerate(pull, { ...dns, portable: true })).toMatchObject({ brief: { touched: [{ id: dnsId }] } });
  expect(regenerate(pull, page, 'low')).toMatchObject({ brief: { touched: [{ id: pageId }] } });
  expect(cachedGeneration(db, 'dns-brief')).toMatchObject({ brief: { touched: [{ id: dnsId }] } });
  expect(cachedGeneration(db, 'page-brief')).toMatchObject({ brief: { touched: [{ id: pageId }] } });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('keeps released alias contradictions from lending mastery to another meaning of the same key', () => {
  const old = { key: 'tcp', title: 'HTTP', summary: 'Messages must arrive in order.', portable: true };
  const contradictory = createFootprint({ ...old, portable: false }, ['tcp', 'http', old.summary.toLowerCase()]);
  seedSavedChange(pull, 'high', 'contradictory', old, contradictory);
  recordEvidence(db, { workspaceId, snapshotId, conceptId: contradictory, depth: 'low', status: 'demonstrated', source: 'check', masteryVerified: true });

  migrate(db);
  const next = regenerate(pull, { ...old, title: 'TCP' });
  if (next.kind !== 'change') throw new Error('Expected a saved change.');
  const correct = next.brief.touched[0]!.id;
  expect(correct).not.toBe(contradictory);
  expect(regenerate(pull, old, 'low')).toMatchObject({ brief: { touched: [{ id: contradictory }] } });
  const { concepts } = getGlobalKnowledgeGraph(db);
  expect(concepts.find(c => c.id === contradictory)?.masteredDepth).toBe('low');
  expect(concepts.find(c => c.id === correct)?.masteredDepth).toBeNull();
});

it('recovers a released footprint that was only linked as a prerequisite', () => {
  const prerequisite = { ...footprint, key: 'positive-replies', title: 'Positive replies', summary: 'A reply confirms delivery.' };
  const target = createFootprint(footprint);
  const known = createFootprint(prerequisite);
  seedSavedChange(pull, 'high', 'saved', footprint, target);
  const edges = [{ concept: footprint.key, prerequisite: prerequisite.key }];
  db.prepare("UPDATE repository_generations SET proposal = ? WHERE cache_key = 'saved'")
    .run(JSON.stringify({ concepts: [footprint, prerequisite], edges, touched: [footprint.key] }));
  db.prepare('INSERT INTO concept_edges VALUES (?, ?, ?)').run(target, known, '2026-01-01');
  recordEvidence(db, { workspaceId, snapshotId, conceptId: known, depth: 'high', status: 'demonstrated', source: 'check', masteryVerified: true });

  migrate(db);
  const before = getGlobalKnowledgeGraph(db);
  expect(regenerate(pull, footprint, 'medium', prerequisite)).toMatchObject({ brief: { touched: [{ id: target }] } });
  const after = getGlobalKnowledgeGraph(db);
  expect(after.concepts).toHaveLength(before.concepts.length);
  expect(after.edges.filter(edge => edge.conceptId === target)).toEqual([{ conceptId: target, prerequisiteId: known }]);
  expect(after.concepts.find(c => c.id === known)?.masteredDepth).toBe('high');
});

it.each(['tcp', 'sending-data'])('preserves the schema-9 baseline binding for %s without relying on its title', key => {
  const target = { key, title: 'TCP', summary: 'Messages arrive in order.', portable: true };
  const sender = { ...footprint, key: 'sender', title: 'Local sender' };
  const releasedFingerprint = digest(['tcp', target.summary.toLowerCase()]);
  const scoped = upsertConcept(db, { ...target, key: 'ambiguous/' + releasedFingerprint, portable: false, workspaceId });
  const local = upsertConcept(db, { ...sender, workspaceId });
  db.prepare('INSERT INTO scoped_proposal_concepts VALUES (?, ?, ?)').run(workspaceId, releasedFingerprint, scoped.id);
  const member = db.prepare('INSERT INTO snapshot_concepts VALUES (?, ?)');
  member.run(snapshotId, scoped.id);
  member.run(snapshotId, local.id);
  db.prepare('INSERT INTO concept_edges VALUES (?, ?, ?)').run(scoped.id, local.id, '2026-01-01');
  recordEvidence(db, { workspaceId, snapshotId, conceptId: scoped.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true });
  const proposal = baselineReply.parse({ schema: 'delve.map/1', concepts: [target, sender],
    edges: [{ concept: target.key, prerequisite: sender.key }], recommendation: { key: target.key, reason: 'Study the sender.' } });
  const source = (commit: string): ApprovedSource => ({ cacheKey: commit, revision: commit,
    request: { workspaceId, selection: { kind: 'baseline', commit, paths: ['web.ts'] }, depth: 'medium', provider: 'codex' },
    preview: { ...selectModel('codex'), title, commit, bytes: 1, prompt: 'test', files: [], token: 'test', partial: false } });
  db.prepare(`INSERT INTO repository_generations (cache_key, workspace_id, snapshot_id, kind, ref, depth, provider, model, schema_version,
    result, proposal, next_concept, reason, created_at, last_used) VALUES (?, ?, ?, 'baseline', ?, 'medium', 'codex', ?, 'delve.map/1',
    '{"kind":"baseline"}', ?, ?, 'Study the sender.', '2026-01-01', 1)`)
    .run(head, workspaceId, snapshotId, head, cacheModel(selectModel('codex').model), JSON.stringify(proposal), scoped.id);

  migrate(db);
  expect(useCachedGeneration(db, source(head))).toEqual({ kind: 'baseline' });
  persistGeneration(db, source(base), proposal);
  const lookUp = db.prepare('SELECT next_concept FROM repository_generations WHERE cache_key = ?');
  expect(lookUp.get(head)?.next_concept).toBe(scoped.id);
  expect(lookUp.get(base)?.next_concept).toBe(scoped.id);
  const graph = readWorkspaceGraph(db, workspaceId);
  expect(graph.concepts).toHaveLength(2);
  expect(graph.edges).toEqual([{ conceptId: scoped.id, prerequisiteId: local.id }]);
  expect(listEvidence(db, scoped.id)).toMatchObject([{ conceptId: scoped.id, masteryVerified: true }]);
  const different = 'c'.repeat(40);
  const differentKey = key === 'tcp' ? 'sending-data' : 'tcp';
  persistGeneration(db, source(different), { ...proposal, concepts: [{ ...target, key: differentKey }, sender],
    edges: [{ concept: differentKey, prerequisite: sender.key }], recommendation: { ...proposal.recommendation, key: differentKey } });
  expect(lookUp.get(different)?.next_concept).not.toBe(scoped.id);
});

it.each([false, true])('keeps a saved footprint for both PR and head commit scopes (commit saved first: %s)', commitFirst => {
  const id = createFootprint(footprint);
  const views = commitFirst ? [commit, pull] : [pull, commit];
  for (const view of views) seedSavedChange(view, 'high', view.kind, footprint, id);
  recordEvidence(db, { workspaceId, snapshotId, conceptId: id, depth: 'high', status: 'demonstrated', source: 'check', masteryVerified: true });
  migrate(db);
  const count = getGlobalKnowledgeGraph(db).concepts.length;
  for (const view of views) {
    expect(latestBrief(db, { ...view, workspaceId, provider: 'codex', depth: 'high' })).toMatchObject({ touched: [{ id }] });
    expect(regenerate(view, { ...footprint, portable: true })).toMatchObject({ brief: { touched: [{ id }] } });
  }
  const concepts = getGlobalKnowledgeGraph(db).concepts;
  expect(concepts).toHaveLength(count);
  expect(concepts.find(c => c.id === id)?.masteredDepth).toBe('high');
});

it.each([false, true])('reuses a schema-9 binding after a portability flip (portable first: %s)', portableFirst => {
  const oldInput = { ...footprint, portable: portableFirst };
  const id = portableFirst ? upsertConcept(db, { ...oldInput, workspaceId }).id : createFootprint(oldInput);
  seedSavedChange(pull, 'high', 'saved', oldInput, id);
  recordEvidence(db, { workspaceId, snapshotId, conceptId: id, depth: 'high', status: 'demonstrated', source: 'check', masteryVerified: true });

  migrate(db);
  const count = getGlobalKnowledgeGraph(db).concepts.length;
  expect(regenerate(pull, { ...footprint, portable: !portableFirst })).toMatchObject({ brief: { touched: [{ id }] } });
  expect(regenerate(pull, oldInput, 'low')).toMatchObject({ brief: { touched: [{ id }] } });
  expect(getGlobalKnowledgeGraph(db).concepts).toHaveLength(count);
  expect(getGlobalKnowledgeGraph(db).concepts.find(c => c.id === id)?.masteredDepth).toBe('high');
});

it('keeps independent released local and portable footprints in their own scopes without adding a third', () => {
  const local = createFootprint(footprint);
  const portable = upsertConcept(db, { ...footprint, portable: true, workspaceId }).id;
  seedSavedChange(pull, 'high', 'local', footprint, local);
  seedSavedChange(pull, 'low', 'portable', { ...footprint, portable: true }, portable);
  recordEvidence(db, { workspaceId, snapshotId, conceptId: local, depth: 'high', status: 'demonstrated', source: 'check', masteryVerified: true });
  migrate(db);

  expect(regenerate(pull, footprint)).toMatchObject({ brief: { touched: [{ id: local }] } });
  const count = getGlobalKnowledgeGraph(db).concepts.length;
  expect(regenerate(pull, { ...footprint, portable: true })).toMatchObject({ brief: { touched: [{ id: portable }] } });
  expect(getGlobalKnowledgeGraph(db).concepts).toHaveLength(count);
  expect(getGlobalKnowledgeGraph(db).concepts.find(c => c.id === local)?.masteredDepth).toBe('high');
  expect(getGlobalKnowledgeGraph(db).concepts.find(c => c.id === portable)?.masteredDepth).toBeNull();
});

it('keeps original concept and lesson IDs for both providers’ schema-9 briefs', () => {
  const id = createFootprint(footprint);
  const codex = seedSavedChange(pull, 'high', 'codex-brief', footprint, id);
  const claude = seedSavedChange(pull, 'high', 'claude-brief', footprint, id, 'claude');
  const upgraded = migrate(db);
  expect(migrate(db)).toBe(upgraded);
  const saved = { ...pull, workspaceId, depth: 'high' } as const;
  expect(latestBrief(db, { ...saved, provider: 'codex' })).toMatchObject({ conceptId: codex.conceptId, lessonId: codex.id });
  expect(latestBrief(db, { ...saved, provider: 'claude' })).toMatchObject({ conceptId: claude.conceptId, lessonId: claude.id });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('keeps per-provider mastery after a sibling writes to an upgraded schema-9 profile', () => {
  const id = createFootprint(footprint);
  const codex = seedSavedChange(pull, 'high', 'codex-brief', footprint, id);
  const sibling = seedLesson(codex.conceptId, 'claude-tutoring', 'claude', 'high');
  const address = { workspaceId, conceptId: codex.conceptId, depth: 'high' } as const;
  const scope = masteryScope({ ...address, snapshotId }, lessonRevision(codex.id, codex.body));
  const revision = 'f'.repeat(64);
  const state = JSON.stringify({ stage: 'skipped', check: null, attempts: 0, correctAnswers: 0, applied: false, cycle: 0, prompts: [] });
  db.prepare("INSERT INTO lesson_mastery (workspace_id, concept_id, depth, lesson_id, scope, revision, state) VALUES (?, ?, 'high', ?, ?, ?, ?)")
    .run(workspaceId, codex.conceptId, codex.id, scope, revision, state);

  migrate(db);
  const pinned = { ...address, lessonId: codex.id };
  expect(readLesson(db, pinned)).toMatchObject({ blocks: [{ text: 'codex-brief' }, expect.anything()], mastery: { stage: 'skipped', revision } });
  const siblingAddress = { ...address, lessonId: sibling.id };
  const siblingState = readLesson(db, siblingAddress);
  expect(siblingState.mastery.stage).toBe('checking');
  expect(readerHandlers(db)['reader:skip']({ ...siblingAddress, revision: siblingState.mastery.revision! }))
    .toMatchObject({ mastery: { stage: 'skipped' } });
  expect(readLesson(db, pinned).mastery).toMatchObject({ stage: 'skipped', revision });
  expect(readLesson(db, address).mastery.stage).toBe('skipped');
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('migrates attributable conversation messages and keeps ambiguous ones in the general history', () => {
  const id = createFootprint(footprint);
  const codex = seedSavedChange(pull, 'high', 'codex-brief', footprint, id);
  const claude = seedSavedChange(pull, 'high', 'claude-brief', footprint, id, 'claude');
  seedLesson(codex.conceptId, 'claude-tutoring', 'claude', 'high');
  const history = db.prepare(`INSERT INTO conversations (workspace_id, concept_id, lesson_id, depth, title, created_at, updated_at)
    VALUES (?, ?, ?, 'high', 'Saved change conversation', '2026-01-01', '2026-01-01')`);
  const message = db.prepare(`INSERT INTO messages (conversation_id, role, body, created_at) VALUES (?, 'learner', ?, '2026-01-01')`);
  for (const [lesson, question] of [[codex, 'My Codex question'], [claude, 'My Claude question']] as const)
    message.run(history.run(workspaceId, lesson.conceptId, lesson.id).lastInsertRowid, JSON.stringify(question));

  migrate(db);
  const read = (lesson: typeof codex, pinned: boolean) => readLesson(db, {
    workspaceId, conceptId: lesson.conceptId, depth: 'high', lessonId: pinned ? lesson.id : undefined,
  }).messages.map(m => m.text);
  expect(read(codex, true)).toEqual([]);
  expect(read(codex, false)).toEqual(['My Codex question']);
  expect(read(claude, true)).toEqual(['My Claude question']);
});
