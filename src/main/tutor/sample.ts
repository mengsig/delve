import assert from 'node:assert/strict';
import { demoDocument, demoMaterial, demoReply } from '../reader/demo';
import type { Document } from '../reader/document';
import type { PreparedTurn } from './prompt';
import type { TutorReply } from './provider';
import { canRecommend, nextGrade } from './mastery';
import { demoCheck } from './sample-checks';

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

function reasoningFeedback(key: string, reasoning: string | undefined) {
  if (!reasoning?.trim()) return null;
  const { id, item } = demoMaterial(key);
  const text = reasoning.trim().replace(/[.!?]+$/, '');
  if (id === 'lease') {
    if (/^(?:(?:I thought |I think )?arrival order (?:matters|mattered|decides)|(?:the )?first (?:result|worker|writer) (?:wins|always wins|should win))$/i.test(text)) {
      return { focus: 'arrival', feedback: 'You looked at arrival order. Even the first result can carry an expired claim; compare it with the active generation.' };
    }
    const currentClaim = /^(?:because )?B (?:still )?(?:holds|has) the current (?:lease|claim)$/i;
    const matchesCurrent = /^(?:because )?(?:the generation (?:is stale|does not match)|the active generation (?:must match|matches|decides))$/i;
    const ownerFromClaim = /^(?:I think )?B owns the task (?:now )?because (?:its|B's) claim is current$/i;
    if (currentClaim.test(text) || matchesCurrent.test(text) || ownerFromClaim.test(text)) {
      return { focus: 'claim', feedback: 'Your reasoning uses the claim and its active generation to identify the owner. That comparison is what protects the write.' };
    }
  }
  if (id === 'exposure') {
    if (/^(?:because )?(?:raising |higher |changing )?ISO (?:freezes motion|reduces (?:motion )?blur|shortens the motion trail)$/i.test(text)) {
      return { focus: 'iso', feedback: 'ISO changes displayed brightness. Shortening the shutter time is what limits the distance the rider moves during exposure.' };
    }
    if (/^(?:because )?(?:a (?:faster shutter|shorter exposure) (?:limits|reduces) (?:motion|blur|motion blur)|ISO (?:only )?changes (?:the )?brightness)$/i.test(text)) {
      return { focus: 'shutter', feedback: 'You separated brightness from motion. ISO changes the rendered brightness, and shutter duration controls how much movement appears.' };
    }
  }
  if ([item.mechanics, item.detail].some(rule => rule.replace(/[.!?]+$/, '').toLowerCase() === text.toLowerCase())) {
    return { feedback: 'You identified the rule that governs the scenario. ' + item.detail };
  }
  return { feedback: id === 'lease' ? 'Which claim would your rule allow the writer to accept, and how would it identify the current owner?'
    : id === 'exposure' ? 'Which camera setting does your explanation change, and what would happen to the motion trail?'
      : 'How would your reasoning change what happens in this example?' };
}

function assessDemo(turn: PreparedTurn, response: NonNullable<PreparedTurn['response']>): TutorReply {
  const { context, mastery, nextConcepts } = turn;
  const { item } = demoMaterial(context.key);
  const [reference] = response.reference;
  assert.ok(mastery.check && reference !== undefined);
  assert.equal(turn.request.intent.kind, 'answer');
  const { correct } = response;
  const rationale = reasoningFeedback(context.key, response.reasoning);
  const selection = correct ? '“' + response.answer + '” is correct. ' + item.mechanics
    : '“' + response.answer + '” does not fit this case. The correct choice is “' + reference + '”. ' + item.mechanics;
  const observation = [selection, rationale?.feedback].filter(Boolean).join(' ');
  const blocks: Document['blocks'] = [{ type: 'prose', heading: correct ? 'Why that works' : 'Let’s look at the decision again',
    text: item.mechanics }, sampleExample(turn)];
  const next = nextGrade(mastery, correct);
  if (next.stage === 'checking') blocks.push(demoCheck(turn, next.attempts, mastery.cycle, rationale?.focus));
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
