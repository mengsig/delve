import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Depth } from '../../shared/domain';
import type { TutorRequest } from '../../shared/reader';
import { openDatabase, type Db } from '../db/connection';
import { readWorkspaceGraph } from '../db/graph';
import { seedDemoWorkspaces } from '../db/demo';
import { DEMO_CONCEPTS, DEMO_WORKSPACES, type DemoConceptId } from '../db/demo-fixtures';
import { demoDocument } from '../reader/demo';
import { freshCheckSchema } from '../reader/document';
import { assertFreshCheck, checkIn } from './mastery';
import { prepareTurn } from './prompt';
import { demoTurn } from './sample';
import { demoCheck } from './sample-checks';
import { executeTurn } from './turn';

let db: Db;

beforeAll(async () => {
  db = openDatabase(':memory:');
  seedDemoWorkspaces(db);
  for (const id of ['lease', 'exposure', 'iso', 'fence'] as const) {
    await submit(requestFor(id, 'medium'), { kind: 'teach' });
  }
});
afterAll(() => db.close());

function requestFor(id: DemoConceptId, depth: Depth): TutorRequest {
  const workspace = DEMO_WORKSPACES.find(entry => entry.concepts.includes(id))!;
  const concept = readWorkspaceGraph(db, workspace.id).concepts.find(entry => entry.title === DEMO_CONCEPTS[id][0]);
  expect(concept).toBeDefined();
  expect(concept?.key).toMatch(new RegExp(id + '$'));
  return { workspaceId: workspace.id, provider: 'demo', conceptId: concept!.id, depth,
    intent: { kind: 'ask', text: 'How does this work?' } };
}

function submit(request: TutorRequest, intent: TutorRequest['intent']) {
  const turn = prepareTurn(db, { ...request, intent });
  expect(turn.context.demo).toBe(true);
  expect(turn.request.intent.kind).toBe(intent.kind);
  return executeTurn(db, async () => demoTurn(turn), turn, new AbortController().signal);
}

const shape = (prompt: string) => prompt.replace(/\d+/g, '#');
const depthCases = ['high', 'medium', 'low'] as const;
const concepts = Object.keys(DEMO_CONCEPTS) as DemoConceptId[];

it.each(concepts.filter(id => id !== 'lease' && id !== 'exposure'))(
  'uses distinct applied situations at every depth across retries and review for %s', id => {
    for (const depth of depthCases) {
      const turn = prepareTurn(db, requestFor(id, depth));
      const opening = checkIn(demoDocument(turn.context))!;
      let previous = opening;
      const prompts = [opening.prompt];
      const firstShapes = new Set<string>();
      for (let cycle = 0; cycle < 3; cycle++) {
        for (let attempt = 0; attempt < turn.mastery.maxAttempts; attempt++) {
          const mastery = { ...turn.mastery, prompts, check: previous };
          const check = demoCheck({ ...turn, mastery }, attempt, cycle);
          assertFreshCheck(mastery, check);
          expect(shape(check.prompt)).not.toBe(shape(previous.prompt));
          expect(check.options?.slice().sort()).not.toEqual(previous.options?.slice().sort());
          if (cycle === 0 && attempt < (depth === 'low' ? 3 : 2)) firstShapes.add(shape(check.prompt));
          prompts.push(check.prompt);
          previous = check;
        }
      }
      expect(firstShapes.size).toBe(depth === 'low' ? 3 : 2);
    }
  },
);

it('teaches from a missed journal replay decision, then opens review with a different case', async () => {
  const request = requestFor('journal', 'low');
  await submit(request, { kind: 'teach' });
  const opened = prepareTurn(db, request);
  const opening = freshCheckSchema.parse(opened.mastery.check);
  let lesson = await submit(request, { kind: 'answer', revision: opened.mastery.revision!, answer: (opening.expected + 1) % 4 });
  const replay = prepareTurn(db, request);
  expect(replay.mastery.check?.prompt).toMatch(/crashed before committing its cursor/);
  const check = freshCheckSchema.parse(replay.mastery.check);
  lesson = await submit(request, { kind: 'answer', revision: lesson.mastery.revision!, answer: (check.expected + 1) % 4 });
  expect(lesson.messages.at(-1)).toMatchObject({
    correct: false, observation: expect.stringContaining('An idempotent projection makes replay safe'),
    blocks: expect.arrayContaining([expect.objectContaining({ type: 'example', setup: check.prompt,
      takeaway: check.options[check.expected] })]),
  });
  while (lesson.mastery.stage === 'checking') {
    const { expected } = freshCheckSchema.parse(prepareTurn(db, request).mastery.check);
    lesson = await submit(request, { kind: 'answer', revision: lesson.mastery.revision!, answer: (expected + 1) % 4 });
  }
  const previous = prepareTurn(db, request);
  const review = await submit(request, { kind: 'review', revision: lesson.mastery.revision! });
  expect(review.mastery).toMatchObject({ stage: 'checking', attempts: 0 });
  const next = review.mastery.activeCheck!.prompt;
  expect(previous.mastery.prompts).not.toContain(next);
  expect(review.messages.at(-1)?.blocks?.find(block => block.type === 'example')).not.toMatchObject({ setup: next });
});

const offlineLimit = 'Delve can’t judge this reasoning offline.';
const matchesKeyIdea = 'That matches the key idea.';
const expiredWins = 'An expired claim cannot authorize a write.';

it.each([
  ['lease', 'Does the active claim matter? The expired claim wins.', expiredWins],
  ['lease', 'Does the active claim matter?The expired claim wins.', expiredWins],
  ['lease', 'The active claim wins, but does the queue need to wait? The expired claim wins.', offlineLimit],
  ['lease', 'I would accept the expired claim; why would anyone wait? The active claim wins.', offlineLimit],
  ['lease', "The active claim wins over the expired claim. Arrival order doesn't matter.", matchesKeyIdea],
  ['lease', 'The newer token should be accepted.', offlineLimit],
  ['lease', 'The latest claim wins.', offlineLimit],
  ['lease', 'The current claim?', offlineLimit],
  ['lease', 'Maybe the active claim wins.', offlineLimit],
  ['lease', 'Accept the current claim if it arrives first.', offlineLimit],
  ['lease', 'The expired claim should be accepted, but B still holds the active claim.', offlineLimit],
  ['lease', 'I would write the result from the expired claim. B still holds the active claim.', expiredWins],
  ['lease', 'I compare the active claim to the worker’s start time.', offlineLimit],
  ['lease', 'The expired claim should never be accepted.', offlineLimit],
  ['lease', 'The active claim wins over the expired claim.', matchesKeyIdea],
  ['lease', 'The expired claim wins over the active claim.', expiredWins],
  ['lease', 'I would save the result from the current lease instead of the expired lease.', matchesKeyIdea],
  ['lease', 'I would save the result from the expired lease instead of the current lease.', expiredWins],
  ['lease', 'The expired claim wins.', expiredWins],
  ['lease', 'The stale token should be accepted.', expiredWins],
  ['lease', 'A reported first. The active token wins.', matchesKeyIdea],
  ['lease', 'The active claim wins. The expired claim should be accepted.', offlineLimit],
  ['lease', 'The expired claim wins?', offlineLimit],
  ['lease', 'Does the expired claim win? Maybe the active claim wins.', offlineLimit],
  ['lease', 'Does the expired claim win? The active claim wins?', offlineLimit],
  ['lease', 'The active claim wins. Or does it?', offlineLimit],
  ['lease', 'The active claim wins. Maybe arrival order matters.', offlineLimit],
  ['lease', 'The active claim wins and the expired claim wins.', offlineLimit],
  ['lease', 'B holds the current claim.', offlineLimit],
  ['lease', 'The older token wins.', offlineLimit],
  ['lease', 'newer token', offlineLimit],
  ['lease', 'The first result wins.', offlineLimit],
  ['lease', 'I went with whoever reported first, since completion order determines the winner.', offlineLimit],
  ['lease', 'B has the newer claim now. A’s lease has already expired.', offlineLimit],
  ['lease', 'The first worker wins, but the newer token should be checked too.', offlineLimit],
  ['lease', "I compare the active claim to the worker's start time.", offlineLimit],
  ['lease', 'I compare the claim to the worker’s start time.', offlineLimit],
  ['lease', 'The expired claim.', offlineLimit],
  ['lease', 'Maybe the lease? I’m unsure which result they should save.', offlineLimit],
  ['exposure', 'A shorter exposure reduces motion blur.', matchesKeyIdea],
  ['exposure', 'A longer exposure reduces motion blur.', 'At the same subject speed'],
  ['exposure', 'A shorter exposure reduces motion blur, or maybe ISO does.', offlineLimit],
  ['exposure', 'I turned the ISO up to make the cyclist sharper.', offlineLimit],
  ['exposure', 'ISO can’t change the blur. A faster shutter cuts the motion trail.', offlineLimit],
  ['exposure', 'I raised the ISO to make it brighter without adding blur.', offlineLimit],
  ['exposure', 'I would increase ISO for brightness at the same shutter speed, without changing blur.', offlineLimit],
  ['exposure', 'A longer shutter time reduces motion blur.', 'At the same subject speed'],
  ['exposure', 'I know ISO affects it, but I’m unsure what changes.', offlineLimit],
  ['iso', 'Maybe ISO? I also changed the shutter.', offlineLimit],
  ['fence', 'Should the writer save the result?', offlineLimit],
] as const)('keeps the keyed grade and gives conservative offline feedback for %s: %s', (id, reasoning, prefix) => {
  const request = requestFor(id, 'medium');
  const { mastery } = prepareTurn(db, request);
  const { expected } = freshCheckSchema.parse(mastery.check);
  const intent = { kind: 'answer' as const, revision: mastery.revision!, answer: expected };
  const turn = prepareTurn(db, { ...request, intent: { ...intent, reasoning } });
  const reply = demoTurn(turn);
  expect(reply.assessment).toBe(true);
  expect(reply.reasoningFeedback?.startsWith(prefix)).toBe(true);
  assertFreshCheck(mastery, checkIn(reply.lesson)!);
  if (prefix === offlineLimit) {
    const ordinary = demoTurn(prepareTurn(db, { ...request, intent }));
    expect(checkIn(reply.lesson)).toEqual(checkIn(ordinary.lesson));
    expect(reply.reasoningFeedback).not.toMatch(/matches the key idea|your reasoning is (?:right|wrong)/i);
    expect(reply.reasoningFeedback!.slice(offlineLimit.length).trim().length).toBeGreaterThan(20);
  }
});

it('saves the keyed grade and corrects an explicit stale-wins decision', async () => {
  const request = requestFor('lease', 'high');
  const lesson = await submit(request, { kind: 'teach' });
  const { mastery } = prepareTurn(db, request);
  const check = freshCheckSchema.parse(mastery.check);
  const saved = await submit(request, { kind: 'answer', revision: lesson.mastery.revision!, answer: check.expected,
    reasoning: 'I would write the result from the expired claim. B still holds the active claim.' });
  expect(saved.mastery).toMatchObject({ attempts: 1, correctAnswers: 1 });
  expect(saved.messages.at(-2)?.text).toContain('I would write the result from the expired claim. B still holds the active claim.');
  expect(saved.messages.at(-1)).toMatchObject({ correct: true, reasoningFeedback: expect.stringContaining(expiredWins) });
});
