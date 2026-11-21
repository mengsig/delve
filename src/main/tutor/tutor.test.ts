import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TutorIntent, TutorRequest } from '../../shared/reader';
import { addPrerequisite, upsertConcept } from '../db/concepts';
import { openDatabase, type Db } from '../db/connection';
import { seedDemoWorkspaces } from '../db/demo';
import { listEvidence, recordEvidence, resetEvidence } from '../db/evidence';
import { readWorkspaceGraph } from '../db/graph';
import { bindSnapshot, saveLesson } from '../db/lessons';
import { addWorkspace } from '../db/workspaces';
import { readLesson } from '../reader/ipc';
import { tutorSchemas } from './ipc';
import { prepareTurn } from './prompt';
import type { Generate, TutorReply } from './provider';
import { TutorSession } from './session';

let db: Db;
let request: TutorRequest;
let session: TutorSession;
const explanation = { type: 'prose' as const, heading: 'Routing', text: 'The longest matching prefix wins.' };
const check = { type: 'check' as const, kind: 'short-answer' as const, prompt: 'Why use the longer match?', expected: ['It is more specific.'] };
const opening: TutorReply = {
  lesson: { schema: 'delve.lesson/1', blocks: [explanation, check] }, assessment: null, recommendation: null, observation: null,
};

beforeEach(() => {
  db = openDatabase(':memory:');
  const workspaceId = addWorkspace(db, { kind: 'topic', title: 'Networking' }).id;
  const concept = upsertConcept(db, { key: 'routing', title: 'Routing', workspaceId, portable: true });
  request = { workspaceId, conceptId: concept.id, depth: 'medium', provider: 'codex', intent: { kind: 'teach' } };
  session = new TutorSession(db, async () => opening);
});
afterEach(() => { session.close(); db.close(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function run(intent: TutorIntent, base = request) {
  const next = { ...base, intent };
  const { token } = prepareTurn(db, next).preview;
  return session.run({ ...next, token, requestId: randomUUID() });
}

it('previews the exact UTF-8 prompt, chosen depth, known prerequisites and most recent answer', async () => {
  const known = upsertConcept(db, { key: 'ip', title: 'IP addresses', workspaceId: request.workspaceId, portable: true });
  addPrerequisite(db, request.conceptId, known.id);
  recordEvidence(db, { ...request, conceptId: known.id, source: 'check', status: 'demonstrated' });
  recordEvidence(db, { ...request, source: 'environment', status: 'partial', note: 'Chose the default route despite a subnet match.' });
  const calls: string[] = [];
  const generate: Generate = async turn => {
    calls.push(turn.preview.prompt);
    if (!turn.response) return opening;
    return { lesson: { schema: 'delve.lesson/1', blocks: [explanation] }, assessment: true,
      observation: 'The learner correctly identified specificity.', recommendation: { action: 'Try two overlapping networks',
        reason: 'You can now choose between two specific routes.', targetId: null } };
  };
  session = new TutorSession(db, generate);
  const preview = prepareTurn(db, request).preview;
  expect(preview.prompt).toContain('IP addresses');
  expect(preview.prompt).toContain('"depth": "medium"');
  expect(preview.files).toEqual([]);
  expect(preview.prompt).toContain('Chose the default route despite a subnet match.');
  const lesson = await run(request.intent);
  expect(calls[0]).toBe(preview.prompt);
  expect(Buffer.byteLength(calls[0]!)).toBe(preview.bytes);
  expect(lesson.blocks[1]).not.toHaveProperty('expected');
  const answer = await run({ kind: 'answer', revision: lesson.revision!, answer: 'A narrower prefix identifies a smaller network.' });
  expect(answer.messages).toMatchObject([{ role: 'learner' }, { role: 'tutor', observation: expect.stringContaining('specificity') }]);
  expect(answer.reused).toBe(true);
  const follow = prepareTurn(db, { ...request, intent: { kind: 'ask', text: 'What about IPv6?' } });
  expect(follow.preview.prompt).toContain('smaller network');
  expect(follow.preview.prompt).toContain('identified specificity');
  expect(follow.preview.prompt).toContain('What about IPv6?');
});

it('reuses only a demonstrated canonical concept at the selected depth, preserving transferred origins', async () => {
  const origin = addWorkspace(db, { kind: 'topic', title: 'IP' });
  upsertConcept(db, { key: 'routing', title: 'Routing', portable: true, workspaceId: origin.id });
  recordEvidence(db, { ...request, workspaceId: origin.id, status: 'demonstrated', source: 'check' });
  const generate = vi.fn<Generate>(async () => opening);
  session = new TutorSession(db, generate);
  expect(await run(request.intent)).toMatchObject({ reused: true, blocks: [], messages: [] });
  expect(generate).not.toHaveBeenCalled();
  expect((await run(request.intent, { ...request, depth: 'low' })).reused).toBe(false);
  expect(generate).toHaveBeenCalledOnce();
  const other = upsertConcept(db, { key: 'routing', title: 'Routing', portable: false, workspaceId: request.workspaceId });
  expect(readLesson(db, { ...request, conceptId: other.id }).reused).toBe(false);
  expect(listEvidence(db, request.conceptId)[0]?.workspaceId).toBe(origin.id);
});

it('uses the cache only for matching model, provider, depth and snapshot', async () => {
  const generate = vi.fn<Generate>(async () => opening);
  session = new TutorSession(db, generate);
  await run(request.intent);
  await run(request.intent);
  expect(generate).toHaveBeenCalledOnce();
  vi.stubEnv('DELVE_CODEX_MODEL', 'another-model');
  await run(request.intent);
  await run(request.intent, { ...request, provider: 'claude' });
  await run(request.intent, { ...request, depth: 'low' });
  bindSnapshot(db, request.workspaceId, 'abcd001');
  await run(request.intent);
  expect(generate).toHaveBeenCalledTimes(5);
});

it('preserves a valid lesson and transcript on invalid output and rejects stale or mismatched requests', async () => {
  const previous = await run(request.intent);
  session = new TutorSession(db, async () => opening);
  await expect(run({ kind: 'ask', text: 'Why?' })).rejects.toThrow(/outside the end/);
  expect(readLesson(db, request)).toEqual(previous);
  const old = prepareTurn(db, request).preview;
  bindSnapshot(db, request.workspaceId, 'abcd001');
  expect(() => session.run({ ...request, requestId: randomUUID(), token: old.token })).toThrow(/changed/);
  expect(() => prepareTurn(db, { ...request, provider: 'demo' })).toThrow(/provider for this workspace/);
  expect(tutorSchemas['tutor:preview'].safeParse({ ...request, files: ['/etc/passwd'] }).success).toBe(false);
  expect(tutorSchemas['tutor:run'].safeParse({ ...request, token: 'approved', requestId: randomUUID() }).success).toBe(false);
});

it('coalesces duplicate requests, cancels a subscriber independently and commits the result once', async () => {
  let release!: (reply: TutorReply) => void;
  const generate = vi.fn<Generate>(() => new Promise(resolve => { release = resolve; }));
  session = new TutorSession(db, generate);
  const firstId = randomUUID();
  const ask = { ...request, intent: { kind: 'ask' as const, text: 'How does this work?' } };
  const { token } = prepareTurn(db, ask).preview;
  const first = session.run({ ...ask, token, requestId: firstId });
  const second = session.run({ ...ask, token, requestId: randomUUID() });
  expect(generate).toHaveBeenCalledOnce();
  expect(() => run(request.intent)).toThrow(/current tutor response/);
  expect(session.cancel(firstId)).toBe(true);
  await expect(first).rejects.toThrow(/cancelled/);
  expect(generate.mock.calls[0]?.[1].aborted).toBe(false);
  release({ ...opening, lesson: { ...opening.lesson, blocks: [explanation] } });
  expect((await second).messages).toHaveLength(2);
  expect(readLesson(db, ask).messages).toHaveLength(2);
});

it('discards late output after cancellation or a change to the previewed context', async () => {
  let release!: (reply: TutorReply) => void;
  session = new TutorSession(db, () => new Promise(resolve => { release = resolve; }));
  const id = randomUUID();
  const { token } = prepareTurn(db, request).preview;
  const cancelled = session.run({ ...request, token, requestId: id });
  expect(session.cancel(id)).toBe(true);
  await expect(cancelled).rejects.toThrow(/cancelled/);
  release(opening);
  await Promise.resolve();
  expect(readLesson(db, request).blocks).toEqual([]);
  const stale = run(request.intent);
  bindSnapshot(db, request.workspaceId, 'cdef123');
  release(opening);
  await expect(stale).rejects.toThrow(/changed/);
  expect(readLesson(db, request).blocks).toEqual([]);
});

it('the offline provider teaches, answers, adapts the graph path and revises one local check', async () => {
  seedDemoWorkspaces(db);
  session = new TutorSession(db);
  const workspaceId = 'de100000-0000-4000-8000-000000000001';
  const graph = readWorkspaceGraph(db, workspaceId);
  const lease = graph.concepts.find(c => c.title === 'Worker leases')!;
  request = { ...request, workspaceId, conceptId: lease.id, provider: 'demo' };
  const lesson = readLesson(db, request);
  expect(lesson.blocks[0]?.type).toBe('prose');
  expect(lesson.blocks.at(-1)?.type).toBe('check');
  const asked = await run({ kind: 'ask', text: 'Draw a system trace' });
  expect(asked.messages[1]?.blocks?.some(b => b.type === 'trace')).toBe(true);
  const wrong = await run({ kind: 'answer', revision: lesson.revision!, answer: 0 });
  expect(wrong.messages.at(-1)).toMatchObject({ observation: expect.stringContaining('first to report'),
    recommendation: { action: 'Explore Write fencing', reason: expect.any(String) } });
  expect(readWorkspaceGraph(db, workspaceId).suggestions?.medium?.conceptId).toBe(graph.concepts.find(c => c.title === 'Write fencing')?.id);
  expect(listEvidence(db, lease.id)).toMatchObject([{ status: 'partial' }]);
  await run({ kind: 'answer', revision: lesson.revision!, answer: 1 });
  expect(listEvidence(db, lease.id)).toMatchObject([{ revision: 2, status: 'demonstrated' }]);
  resetEvidence(db, lease.id, { depth: 'medium', workspaceId });
  expect(readLesson(db, request).reused).toBe(false);
  expect(readLesson(db, request).messages).toHaveLength(6);
});

it('refuses stale answers and rolls back evidence with the exchange if a message cannot be saved', async () => {
  const lesson = await run(request.intent);
  const intent = { kind: 'answer' as const, revision: lesson.revision!, answer: 'Specific routing.' };
  session = new TutorSession(db, async () => ({ lesson: { schema: 'delve.lesson/1', blocks: [explanation] },
    observation: 'Understands specificity', assessment: true, recommendation: { action: 'Try a route', reason: 'Apply specificity', targetId: null } }));
  db.exec(`CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'write refused'); END`);
  await expect(run(intent)).rejects.toThrow(/write refused/);
  expect(listEvidence(db, request.conceptId)).toEqual([]);
  expect(readLesson(db, request).messages).toEqual([]);
  saveLesson(db, { ...request, model: 'new', provider: 'codex', cacheKey: 'new', schemaVersion: 'delve.lesson/1',
    body: { schema: 'delve.lesson/1', blocks: [explanation] } });
  expect(() => run(intent)).toThrow(/current check/);
});

it('regenerates an invalid latest opening and preserves the fallback if the retry fails', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const previous = await run(request.intent);
  saveLesson(db, { ...request, provider: 'codex', model: 'old', schemaVersion: 'delve.lesson/1', cacheKey: 'invalid',
    body: { schema: 'delve.lesson/1', blocks: [{ type: 'prose', heading: 'Missing text' }] } });
  expect(readLesson(db, request)).toMatchObject({ invalidLatest: true, revision: previous.revision });
  session = new TutorSession(db, async () => { throw new Error('Provider unavailable'); });
  await expect(run(request.intent)).rejects.toThrow('Provider unavailable');
  expect(readLesson(db, request)).toMatchObject({ invalidLatest: true, revision: previous.revision });
  session = new TutorSession(db, async () => ({ ...opening, lesson: { ...opening.lesson, blocks: [{ ...explanation, heading: 'Revised explanation' }] } }));
  expect(await run(request.intent)).toMatchObject({ invalidLatest: false, blocks: [{ heading: 'Revised explanation' }] });
});
