import assert from 'node:assert/strict';
import { demoDocument, demoMaterial, demoReply } from '../reader/demo';
import type { Document } from '../reader/document';
import type { PreparedTurn } from './prompt';
import type { TutorReply } from './provider';

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

export function demoTurn(turn: PreparedTurn): TutorReply {
  const { context, request, response } = turn;
  assert.ok(context.demo && request.provider === 'demo', 'sample replies belong only to explicit demos');
  const base = { assessment: null, recommendation: null, observation: null };
  if (request.intent.kind === 'teach') return { ...base, lesson: demoDocument(context) };
  const { item } = demoMaterial(context.key);
  if (response) {
    const correct = response.correct ?? response.reference.some(answer => answer.toLowerCase() === response.answer.toLowerCase());
    const observation = correct ? 'You connected the decision to the underlying rule.'
      : 'Your prediction used “' + response.answer + '”. Compare that with “' + response.reference[0] + '”.';
    const blocks: Document['blocks'] = [{ type: 'prose', heading: correct ? 'Why that works' : 'Let’s look at the decision again',
      text: item.mechanics }, sampleExample(turn)];
    const targetKey = context.key.endsWith(':lease') ? (correct ? 'recovery' : 'fence')
      : context.key.endsWith(':exposure') ? (correct ? 'pan' : context.depth === 'high' ? 'shutter' : 'iso') : null;
    const target = turn.nextConcepts.find(c => c.key.endsWith(':' + targetKey));
    const recommendation = target
      ? { targetId: target.id, action: 'Explore ' + target.title, reason: target.summary + ' ' + item.detail }
      : { targetId: null, action: correct ? 'Apply this rule to another case' : 'Trace the decision, then revise your prediction',
        reason: correct ? 'You identified the deciding condition in this example.' : item.detail };
    return { lesson: { schema: 'delve.lesson/1', blocks }, assessment: correct, observation, recommendation };
  }
  assert.equal(request.intent.kind, 'ask');
  const question = request.intent.kind === 'ask' ? request.intent.text : '';
  const blocks: Document['blocks'] = [{ type: 'prose', heading: 'About your question', text: demoReply(context, question) }];
  if (/diagram|visual|trace|draw/i.test(question)) {
    blocks.push({ type: 'trace', steps: [context.summary, item.mechanics, item.detail] });
  } else blocks.push(sampleExample(turn));
  return { ...base, lesson: { schema: 'delve.lesson/1', blocks } };
}
