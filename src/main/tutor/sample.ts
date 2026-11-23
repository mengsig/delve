import assert from 'node:assert/strict';
import { demoDocument, demoMaterial, demoReply } from '../reader/demo';
import type { Document } from '../reader/document';
import type { PreparedTurn } from './prompt';
import type { TutorReply } from './provider';
import { canRecommend, nextGrade } from './mastery';
import { demoCheck } from './sample-checks';
import { reasoningFeedback } from './sample-reasoning';
import { scenarioFeedback, transferCase } from './sample-scenarios';

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
  const current = turn.mastery.check;
  const choice = turn.request.intent.kind === 'answer' && current?.options && typeof current.expected === 'number'
    ? { check: { ...current, expected: current.expected, options: current.options }, explanation: item.detail }
    : transferCase(id, turn, true);
  const { check, explanation } = choice;
  const takeaway = check.options[check.expected];
  assert.ok(takeaway && explanation);
  return { type: 'example', heading: 'Work through the decision', setup: check.prompt,
    steps: [explanation], takeaway };
}

function assessDemo(turn: PreparedTurn, response: NonNullable<PreparedTurn['response']>): TutorReply {
  const { context, mastery, nextConcepts } = turn;
  const { id, item } = demoMaterial(context.key);
  const [reference] = response.reference;
  assert.ok(mastery.check && reference !== undefined);
  assert.equal(turn.request.intent.kind, 'answer');
  const { correct } = response;
  const explanation = scenarioFeedback(id, context.depth, mastery.check.prompt) ?? item.mechanics;
  const rationale = response.reasoning?.trim() ? reasoningFeedback(id, response.reasoning, explanation) : null;
  const selection = correct ? '“' + response.answer + '” is correct. ' + explanation
    : '“' + response.answer + '” does not fit this case. The correct choice is “' + reference + '”. ' + explanation;
  const blocks: Document['blocks'] = [{ type: 'prose', heading: correct ? 'Why that works' : 'Let’s look at the decision again',
    text: item.mechanics }, sampleExample(turn)];
  const next = nextGrade(mastery, correct);
  if (next.stage === 'checking') blocks.push(demoCheck(turn, next.attempts, mastery.cycle, rationale?.focus));
  const targetKey = context.key.endsWith(':lease') ? 'recovery' : context.key.endsWith(':exposure') ? 'pan' : null;
  const target = nextConcepts.find(c => c.key.endsWith(':' + targetKey));
  const recommendation = !canRecommend(next) ? null : target
    ? { targetId: target.id, action: 'Explore ' + target.title, reason: target.summary }
    : { targetId: null, action: 'Apply this rule to another case', reason: item.detail };
  const feedback = rationale ? { reasoningFeedback: rationale.feedback } : {};
  return { lesson: { schema: 'delve.lesson/1', blocks }, assessment: correct, observation: selection, recommendation, ...feedback };
}

export function demoTurn(turn: PreparedTurn): TutorReply {
  const { context, request, response } = turn;
  assert.ok(context.demo && request.provider === 'demo', 'sample replies belong only to explicit demos');
  const base = { assessment: null, recommendation: null, observation: null };
  if (request.intent.kind === 'teach') return { ...base, lesson: demoDocument(context) };
  if (response) return assessDemo(turn, response);
  if (request.intent.kind === 'adapt') {
    return { ...base, lesson: { schema: 'delve.lesson/1', blocks: [demoCheck(turn, turn.mastery.attempts, turn.mastery.cycle)] } };
  }
  if (request.intent.kind === 'review') {
    const blocks = [sampleExample(turn), demoCheck(turn, 0, turn.mastery.cycle + 1)];
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
