import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Depth } from '../../shared/domain';
import type { TutorRequest } from '../../shared/reader';
import { addPrerequisite, upsertConcept } from '../db/concepts';
import { openDatabase, type Db } from '../db/connection';
import { listEvidence, recordEvidence } from '../db/evidence';
import { getGlobalKnowledgeGraph } from '../db/knowledge';
import { addWorkspace } from '../db/workspaces';
import { readLesson, readerHandlers } from '../reader/ipc';
import { prepareTurn, previewNewTopic } from './prompt';
import { TutorSession } from './session';
import type { Foundation } from './foundation-content';
import type { TutorReply } from './provider';

const probe = { type: 'check' as const, kind: 'prediction' as const,
  prompt: 'A note gets lost. What tells the sender it never arrived?',
  options: ['No reply comes back', 'Two notes arrive', 'The envelope changes', 'The note arrives sooner'], expected: 0 };
const practice = { ...probe, prompt: 'You receive the note and tell the sender. What should they do?',
  options: ['Send the note again', 'Stop waiting for a reply', 'Remove the address', 'Forget they sent it'], expected: 1 };
const receipt: Foundation = { key: 'delivery-receipts', title: 'Delivery receipts',
  summary: 'A receipt tells the sender a message arrived. Think of signing for a package.',
  why: 'A receipt helps a sender know when to try again.', probe, practice };
const timeout: Foundation = { ...receipt, key: 'wait-limits', title: 'Wait limits',
  summary: 'A wait limit tells you when to stop waiting.', probe: { ...probe, prompt: 'A timer runs out. What happens next?' } };
const opening: TutorReply = { lesson: { schema: 'delve.lesson/1', blocks: [
  { type: 'analogy', heading: 'Try a second time', text: 'Think of calling a friend back when the first call drops.' },
  { ...probe, prompt: 'The first call drops. What would give you a second chance?' },
] }, observation: null, assessment: null, recommendation: null };

let db: Db;
let session: TutorSession;
let request: TutorRequest;

function topic(title: string, depth: Depth = 'high'): TutorRequest {
  const workspaceId = addWorkspace(db, { kind: 'topic', title }).id;
  const conceptId = upsertConcept(db, { key: 'topic', title, portable: false, workspaceId }).id;
  return { workspaceId, conceptId, depth, provider: 'codex', intent: { kind: 'teach' } };
}

const linked = (foundation: Foundation) => upsertConcept(db, { ...foundation, portable: true, workspaceId: request.workspaceId });

function run(input = request) {
  const { token } = prepareTurn(db, input).preview;
  return session.run({ ...input, token, requestId: randomUUID() });
}

const read = (input = request) => readerHandlers(db)['reader:foundation'](input).step;
const respond = (revision: string, answer: number | null, input = request) =>
  readerHandlers(db)['reader:foundation']({ ...input, decision: { revision, answer } });

beforeEach(() => {
  db = openDatabase(':memory:');
  request = topic('Sending messages');
});
afterEach(() => { session.close(); db.close(); });

it('derives and saves foundation links, skips covering proof and unlocks the explanation after short practice', async () => {
  const known = linked(timeout);
  recordEvidence(db, { conceptId: known.id, depth: 'low', status: 'demonstrated', source: 'check', masteryVerified: true });
  const generate = vi.fn(async () => ({ ...opening, foundations: [timeout, receipt] }));
  session = new TutorSession(db, generate);
  const lesson = await run();
  const foundation = lesson.foundation!;
  expect(foundation).toMatchObject({ phase: 'probe', title: receipt.title, position: 1, total: 1 });
  expect(foundation).not.toHaveProperty('expected');
  expect(lesson.blocks).toEqual([]);
  const graph = getGlobalKnowledgeGraph(db);
  const learned = graph.concepts.find(c => c.key === receipt.key)!;
  expect(graph.edges).toEqual(expect.arrayContaining([
    { conceptId: request.conceptId, prerequisiteId: known.id }, { conceptId: request.conceptId, prerequisiteId: learned.id },
  ]));
  expect(() => prepareTurn(db, request)).toThrow(/Finish or skip/);
  expect(() => respond(foundation.revision, 9)).toThrow(/displayed answers/);

  const wrong = respond(foundation.revision, 1);
  expect(wrong).toMatchObject({ step: { phase: 'practice', explanation: receipt.summary }, feedback: expect.stringMatching(/^Not quite —/) });
  expect(listEvidence(db, learned.id)).toMatchObject([{ depth: 'high', status: 'partial', masteryVerified: false }]);
  expect(read()?.revision).toBe(wrong.step?.revision);
  expect(() => respond(foundation.revision, 0)).toThrow(/question changed/);
  expect(respond(wrong.step!.revision, 1)).toMatchObject({ step: null, feedback: expect.stringMatching(/^Right —/) });
  expect(readLesson(db, request)).toMatchObject({ blocks: [opening.lesson.blocks[0], expect.any(Object)],
    foundationIntroduction: 'This builds on Delivery receipts, which you just went through.' });
  const prompt = prepareTurn(db, { ...request, intent: { kind: 'ask', text: 'How do these ideas fit together?' } }).preview.prompt;
  expect(prompt).toContain('Use foundationRecap to connect');
  expect(prompt).toMatch(/"foundationRecap":\s*\{\s*"known":\s*\[\s*"Wait limits"\s*\],\s*"reviewed":\s*\[\s*"Delivery receipts"\s*\]/);
  expect(listEvidence(db, learned.id)).toMatchObject([{ depth: 'high', status: 'demonstrated', masteryVerified: true }]);
  expect(generate).toHaveBeenCalledTimes(1);

  const nextLesson = await run(topic('Acknowledging messages'));
  expect(nextLesson.foundation).toBeUndefined();
  expect(nextLesson.foundationIntroduction).toMatch(/which you already know\.$/);
  expect(getGlobalKnowledgeGraph(db).concepts.filter(c => c.key === receipt.key)).toHaveLength(1);
});

it('uses a known foundation identity from the approved topic prompt and skips its mastered probe', async () => {
  const stable = { ...receipt, key: 'confirming-delivery/v2', summary: 'A reply confirms reception of a pending packet in `dispatchQueue`.' };
  const known = linked(stable);
  recordEvidence(db, { conceptId: known.id, depth: 'low', status: 'demonstrated', source: 'check', masteryVerified: true });
  upsertConcept(db, { ...receipt, key: 'workspace-private', portable: false, workspaceId: request.workspaceId });
  upsertConcept(db, { ...receipt, key: 'x'.repeat(151), portable: true });
  upsertConcept(db, { ...receipt, key: 'oversized', summary: 'x'.repeat(601), portable: true });

  const title = 'Acknowledging messages';
  const preview = previewNewTopic(db, { title, depth: 'high', provider: 'codex' });
  const next = topic(title);
  session = new TutorSession(db, async turn => {
    expect(turn.preview.prompt).toBe(preview.prompt);
    const { knownFoundations } = JSON.parse(turn.preview.prompt.slice(turn.preview.prompt.lastIndexOf('\n{')));
    expect(knownFoundations).toEqual([{ key: stable.key, title: receipt.title, summary: stable.summary }]);
    const [{ key, summary }] = knownFoundations;
    return { ...opening, foundations: [{ ...receipt, key, summary, explanation: receipt.summary, title: 'Knowing a message arrived' }] };
  });

  expect(await run(next)).toMatchObject({ foundationIntroduction: 'This builds on Delivery receipts, which you already know.' });
  expect(read(next)).toBeNull();
  const graph = getGlobalKnowledgeGraph(db);
  expect(graph.edges).toContainEqual({ conceptId: next.conceptId, prerequisiteId: known.id });
  expect(graph.concepts.filter(c => c.key === stable.key)).toHaveLength(1);
  expect(listEvidence(db, known.id)).toMatchObject([{ depth: 'low', masteryVerified: true }]);
});

it.each([
  { key: receipt.key, summary: 'A receipt is an accounting document.' },
  { key: 'other-delivery-receipt', summary: receipt.summary },
])('probes and grades a foundation without borrowing uncorroborated mastery ($key)', async ({ key, summary }) => {
  const workspaceId = addWorkspace(db, { kind: 'topic', title: 'Other receipts' }).id;
  const unrelated = upsertConcept(db, { ...receipt, key, summary, portable: true, workspaceId });
  recordEvidence(db, { conceptId: unrelated.id, depth: 'low', status: 'demonstrated', source: 'check', masteryVerified: true });
  session = new TutorSession(db, async () => ({ ...opening, foundations: [receipt] }));
  const first = (await run()).foundation!;
  expect(first).toMatchObject({ phase: 'probe', title: receipt.title });
  expect(respond(first.revision, 0).step).toBeNull();
  const learned = getGlobalKnowledgeGraph(db).concepts.find(c => c.id !== unrelated.id && c.summary === receipt.summary)!;
  expect(listEvidence(db, unrelated.id)).toHaveLength(1);
  expect(listEvidence(db, learned.id)).toMatchObject([{ status: 'demonstrated', masteryVerified: true }]);
  expect((await run(topic('Remembering delivery'))).foundation).toBeUndefined();
});

it('orders questions bottom-up, infers evidence from the answer, and never repeats an answered probe', async () => {
  const basic = linked(receipt);
  const advanced = linked(timeout);
  addPrerequisite(db, advanced.id, basic.id);
  session = new TutorSession(db, async () => ({ ...opening, foundations: [timeout, receipt] }));
  const first = (await run()).foundation!;
  expect(first).toMatchObject({ title: receipt.title, position: 1, total: 2 });
  const second = respond(first.revision, 1).step!;
  expect(second).toMatchObject({ phase: 'probe', title: timeout.title, position: 2, total: 2 });
  const review = respond(second.revision, 0).step!;
  expect(listEvidence(db, advanced.id)).toMatchObject([{ depth: 'high', status: 'demonstrated', masteryVerified: true }]);
  expect(review).toMatchObject({ phase: 'practice', title: receipt.title });
  expect(respond(review.revision, null).step).toBeNull();
  const laterRequest = topic('Retrying messages', 'medium');
  const next = (await run(laterRequest)).foundation!;
  expect(next).toMatchObject({ phase: 'practice', title: receipt.title });
  expect(respond(next.revision, 1, laterRequest).step).toMatchObject({ phase: 'practice', title: timeout.title, goDeeper: true });
  expect(listEvidence(db, basic.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ depth: 'medium', status: 'demonstrated', masteryVerified: true }),
  ]));
});

it('skips directly to the lesson and keeps the untested foundation on the learning path', async () => {
  session = new TutorSession(db, async () => ({ ...opening, foundations: [receipt] }));
  const first = (await run()).foundation!;
  expect(respond(first.revision, null)).toEqual({ step: null });
  const graph = getGlobalKnowledgeGraph(db);
  const foundation = graph.concepts.find(concept => concept.key === receipt.key)!;
  expect(graph.edges).toContainEqual({ conceptId: request.conceptId, prerequisiteId: foundation.id });
  expect(listEvidence(db, foundation.id)).toEqual([]);
  expect(readLesson(db, request).foundationIntroduction).toBeUndefined();
  const next = await run(topic('Sending a second message'));
  expect(next.foundation).toMatchObject({ phase: 'probe', title: receipt.title });
});

it('offers verified shallower foundations as deeper practice without a new probe or deeper mastery', async () => {
  const foundation = linked(receipt);
  recordEvidence(db, { conceptId: foundation.id, depth: 'high', status: 'demonstrated', source: 'check', masteryVerified: true });
  session = new TutorSession(db, async () => ({ ...opening, foundations: [receipt] }));
  const deepRequest = topic('Retrying a delivery', 'low');
  const first = (await run(deepRequest)).foundation!;
  expect(first).toMatchObject({ phase: 'practice', title: receipt.title, goDeeper: true });
  expect(respond(first.revision, null, deepRequest)).toEqual({ step: null });
  expect(listEvidence(db, foundation.id)).toMatchObject([{ depth: 'high', masteryVerified: true }]);
});

it('regenerates a high-depth opening using the same exact approved prompt', async () => {
  const clunky: TutorReply = { ...opening, lesson: { ...opening.lesson, blocks: [
    { type: 'prose', heading: 'The new setting', text: 'The currentAttempt field changes. The supplied diff is partial.' },
    opening.lesson.blocks[0]!, probe,
  ] } };
  const generate = vi.fn().mockResolvedValueOnce(clunky).mockResolvedValueOnce(opening);
  session = new TutorSession(db, generate);
  const { preview } = prepareTurn(db, request);
  expect(preview.prompt).toContain('identify the 2–4 ideas a learner needs first');
  const lesson = await run();
  expect(lesson.blocks[0]).toEqual(opening.lesson.blocks[0]);
  expect(generate).toHaveBeenCalledTimes(2);
  for (const [turn] of generate.mock.calls) expect(turn.preview).toEqual(preview);
});
