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
  for (const id of ['lease', 'exposure'] as const) {
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

it.each([
  ['lease', 'I went with whoever reported first, since completion order determines the winner.', 'Even the first result can carry an expired claim'],
  ['lease', 'B has the newer claim now. A’s lease has already expired.', 'its active generation'],
  ['lease', 'The first worker wins, but the newer token should be checked too.', 'how would it identify the current owner?'],
  ['lease', 'The expired claim wins.', 'An expired claim cannot authorize a write'],
  ['lease', 'The stale token should be accepted.', 'An expired claim cannot authorize a write'],
  ['lease', 'I compare the claim to the worker’s start time.', 'how would it identify the current owner?'],
  ['lease', 'The active claim wins over the expired claim.', 'Choosing the current claim matches the commit rule'],
  ['lease', 'The expired claim wins over the active claim.', 'An expired claim cannot authorize a write'],
  ['lease', 'I would save the result from the current lease instead of the expired lease.', 'Choosing the current claim matches the commit rule'],
  ['lease', 'I would save the result from the expired lease instead of the current lease.', 'An expired claim cannot authorize a write'],
  ['lease', 'I would write the result from the expired claim. B still holds the active claim.', 'An expired claim cannot authorize a write'],
  ['lease', 'I compare the active claim to the worker’s start time.', 'Which values would your rule compare'],
  ['lease', 'The expired claim should never be accepted.', 'Which values would your rule compare'],
  ['lease', 'The expired claim.', 'how would it identify the current owner?'],
  ['lease', 'Maybe the lease? I’m unsure which result they should save.', 'how would it identify the current owner?'],
  ['exposure', 'I turned the ISO up to make the cyclist sharper.', 'Shortening the shutter time'],
  ['exposure', 'ISO can’t change the blur. A faster shutter cuts the motion trail.', 'Shutter duration controls'],
  ['exposure', 'I raised the ISO to make it brighter without adding blur.', 'Shutter duration controls'],
  ['exposure', 'I would increase ISO for brightness at the same shutter speed, without changing blur.', 'Shutter duration controls'],
  ['exposure', 'A longer shutter time reduces motion blur.', 'A longer exposure gives the subject more time to move'],
  ['exposure', 'I know ISO affects it, but I’m unsure what changes.', 'what would happen to the motion trail?'],
] as const)('explains %s reasoning separately from the trusted choice grade: %s', (id, reasoning, feedback) => {
  const request = requestFor(id, 'medium');
  const { mastery } = prepareTurn(db, request);
  const { expected } = freshCheckSchema.parse(mastery.check);
  const turn = prepareTurn(db, { ...request,
    intent: { kind: 'answer', revision: mastery.revision!, answer: expected, reasoning } });
  const reply = demoTurn(turn);
  expect(reply).toMatchObject({ assessment: true, reasoningFeedback: expect.stringContaining(feedback) });
  assertFreshCheck(mastery, checkIn(reply.lesson)!);
});

it('saves the keyed grade and corrects a learner who trusts an expired claim', async () => {
  const request = requestFor('lease', 'high');
  const lesson = await submit(request, { kind: 'teach' });
  const { mastery } = prepareTurn(db, request);
  const check = freshCheckSchema.parse(mastery.check);
  const saved = await submit(request, { kind: 'answer', revision: lesson.mastery.revision!, answer: check.expected,
    reasoning: 'I would write the result from the expired claim. B still holds the active claim.' });
  expect(saved.mastery).toMatchObject({ attempts: 1, correctAnswers: 1 });
  expect(saved.messages.at(-2)?.text).toContain('I would write the result from the expired claim. B still holds the active claim.');
  expect(saved.messages.at(-1)).toMatchObject({ correct: true, reasoningFeedback: expect.stringContaining('An expired claim cannot authorize a write') });
});
