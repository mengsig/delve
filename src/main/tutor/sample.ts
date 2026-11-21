import assert from 'node:assert/strict';
import { demoDocument, demoMaterial, demoReply } from '../reader/demo';
import type { Document } from '../reader/document';
import type { PreparedTurn } from './prompt';
import type { TutorReply } from './provider';
import { canRecommend, nextGrade, type MasteryCheck } from './mastery';

function sampleExample(turn: PreparedTurn): Document['blocks'][number] {
  const { context } = turn;
  const { id, item } = demoMaterial(context.key);
  if (id === 'lease') return { type: 'example', heading: 'Follow the late result',
    setup: 'Worker A starts with claim 7. Its lease expires while it is still running.',
    steps: ['B receives claim 8 for the same task.', 'A arrives first with claim 7. The writer compares 7 with the active 8 and declines the write.', 'B presents 8. The writer can commit its result.'],
    takeaway: 'Completion time cannot prove ownership. The active generation can.' };
  if (id === 'exposure') return { type: 'example', heading: 'Photograph a moving rider',
    setup: 'At 1/125 s and ISO 200 the exposure is bright, but the rider is blurred.',
    steps: ['Shorten the exposure to 1/500 s to record less motion.', 'At fixed aperture, raise ISO to 800 to restore displayed brightness.'],
    takeaway: 'Shutter time changes recorded motion. ISO changes brightness.' };
  return { type: 'example', heading: 'Work through the decision', setup: item.checks[context.depth].prompt,
    steps: [item.mechanics, item.detail], takeaway: item.checks[context.depth].options[item.checks[context.depth].expected]! };
}

function appliedCheck(turn: PreparedTurn, position: number, cycle: number): MasteryCheck {
  const { context } = turn;
  const { id, item } = demoMaterial(context.key);
  assert.ok(Number.isSafeInteger(position) && position >= 0 && position <= turn.mastery.maxAttempts);
  assert.ok(Number.isSafeInteger(cycle) && cycle >= 0);
  const value = 20 + cycle * 10 + position;
  const block = { type: 'check', kind: 'prediction' } as const;
  if (id === 'lease') {
    if (position % 3 === 0) return { ...block,
      prompt: `A is replaced by B with generation ${value}. A reports before B. Why can A's report be rejected even though B has yet to finish?`,
      expected: ['A is no longer the current lease holder', 'A has a stale generation', 'A has an old generation'] };
    if (position % 3 === 1) return { ...block,
      prompt: `The active claim is generation ${value}. A result arrives with generation ${value - 1}. Should the writer commit it? Give the reason.`,
      expected: ['Reject it because the generation does not match', 'Reject the stale generation', 'No, the generation is stale'] };
    return { ...block,
      prompt: `A result and a reassignment both reach storage. The new claim is generation ${value}. What should the result writer check atomically before committing?`,
      expected: ['The result generation matches the active generation', 'Match the generation to the current lease', 'Compare the active generation'] };
  }
  if (id === 'exposure') {
    const initial = 100 + 10 * value;
    if (position % 3 === 0) return { ...block,
      prompt: `A rider still blurs at 1/${initial} s. At the same aperture, which exposure control would you change first to freeze more movement, and in which direction?`,
      expected: ['Use a faster shutter speed', 'Shorten the exposure time', 'Increase shutter speed'] };
    if (position % 3 === 1) return { ...block,
      prompt: `A 1/${initial * 2} s exposure gives sharp detail but a dark frame. Aperture is fixed. How would you brighten the image without reintroducing motion blur?`,
      expected: ['Raise ISO and keep the shutter time', 'Increase the ISO', 'Raise ISO'] };
    return { ...block,
      prompt: `Two photos use the same shutter time of 1/${initial} s. One uses much higher ISO. Why do the motion trails stay the same length?`,
      expected: ['The shutter time determines motion blur', 'ISO does not change the shutter time', 'The exposure duration is the same'] };
  }
  const scenarios = Object.values(item.checks);
  const scenario = scenarios[position % scenarios.length]!;
  const framing = position < scenarios.length ? 'Apply the rule and explain your reasoning.' : 'Name the decision and the property that makes it safe.';
  return { ...block, prompt: `Case ${value}. ${scenario.prompt} ${framing}`,
    expected: [scenario.options[scenario.expected]!, item.mechanics, item.detail] };
}

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function assessDemo(turn: PreparedTurn, response: NonNullable<PreparedTurn['response']>): TutorReply {
  const { context, mastery, nextConcepts } = turn;
  const { item } = demoMaterial(context.key);
  assert.ok(mastery.check && response.reference.length > 0);
  assert.equal(turn.request.intent.kind, 'answer');
  const answer = normalize(response.answer);
  const correct = response.correct ?? response.reference.some(reference => answer === normalize(reference));
  const observation = correct ? 'You connected the decision to the underlying rule.'
    : '“' + response.answer + '” does not satisfy the rule: ' + item.mechanics + ' The right answer is “' + response.reference[0] + '”.';
  const blocks: Document['blocks'] = [{ type: 'prose', heading: correct ? 'Why that works' : 'Let’s look at the decision again',
    text: item.mechanics }, sampleExample(turn)];
  const next = nextGrade(mastery, correct);
  if (next.stage === 'checking') blocks.push(appliedCheck(turn, next.attempts, mastery.cycle));
  const targetKey = context.key.endsWith(':lease') ? 'recovery' : context.key.endsWith(':exposure') ? 'pan' : null;
  const target = nextConcepts.find(c => c.key.endsWith(':' + targetKey));
  const recommendation = !canRecommend(next) ? null : target
    ? { targetId: target.id, action: 'Explore ' + target.title, reason: target.summary }
    : { targetId: null, action: 'Apply this rule to another case', reason: item.detail };
  return { lesson: { schema: 'delve.lesson/1', blocks }, assessment: correct, observation, recommendation };
}

export function demoTurn(turn: PreparedTurn): TutorReply {
  const { context, request, response } = turn;
  assert.ok(context.demo && request.provider === 'demo', 'sample replies belong only to explicit demos');
  const base = { assessment: null, recommendation: null, observation: null };
  if (request.intent.kind === 'teach') return { ...base, lesson: demoDocument(context) };
  if (response) return assessDemo(turn, response);
  if (request.intent.kind === 'review') {
    const blocks = [sampleExample(turn), appliedCheck(turn, 0, turn.mastery.cycle + 1)];
    return { ...base, lesson: { schema: 'delve.lesson/1', blocks } };
  }
  assert.equal(request.intent.kind, 'ask');
  const question = request.intent.kind === 'ask' ? request.intent.text : '';
  const blocks: Document['blocks'] = [{ type: 'prose', heading: 'About your question', text: demoReply(context, question) }];
  if (turn.lastPractice?.observation && turn.lastPractice.recommendation) {
    const { observation, recommendation } = turn.lastPractice;
    blocks.push({ type: 'callout', heading: 'From your last run', text: canRecommend(turn.mastery)
      ? [observation, recommendation.reason, recommendation.action].join(' ') : observation });
  }
  const lab = turn.selected.document?.blocks.find(block => block.type === 'environment');
  if (turn.needsDiagram) {
    const { id } = demoMaterial(context.key);
    const nodes = id === 'lease' ? ['Claim expires', 'Dispatcher grants next generation', 'Writer checks ownership']
      : id === 'exposure' ? ['Shutter time', 'Motion blur', 'ISO restores brightness']
        : ['Starting condition', context.title, 'Observable result'];
    blocks.push({ type: 'diagram', nodes, edges: [{ from: 0, to: 1 }, { from: 1, to: 2 }] });
  } else if (lab && /\b(lab|simulate|simulation|instrument|practice)\b/i.test(question)) {
    blocks.push(lab);
  } else blocks.push(sampleExample(turn));
  return { ...base, lesson: { schema: 'delve.lesson/1', blocks } };
}
