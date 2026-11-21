import assert from 'node:assert/strict';
import { z } from 'zod';
import { DomainError } from '../../shared/errors';
import { detectProviders } from '../providers/detect';
import { ProviderRunner } from '../providers/runner';
import { documentGenerationSchema, documentJsonSchema, type Document } from '../reader/document';
import { observationSchema, recommendationSchema } from '../reader/conversation';
import type { PreparedTurn } from './prompt';
import { demoTurn } from './sample';

const metadata = z.strictObject({
  observation: observationSchema.nullable(),
  recommendation: recommendationSchema.extend({ targetId: z.int().positive().nullable() }).nullable(),
  assessment: z.boolean().nullable(),
});

export type TutorReply = z.infer<typeof metadata> & { lesson: Document };
export type Generate = (turn: PreparedTurn, signal: AbortSignal) => Promise<TutorReply>;

const replySchema = metadata.extend({ lesson: documentGenerationSchema });
const json = z.toJSONSchema(metadata, { target: 'draft-7', override: ({ jsonSchema }) => {
  delete jsonSchema.minLength;
  delete jsonSchema.maxLength;
  delete jsonSchema.minimum;
  delete jsonSchema.maximum;
  delete jsonSchema.exclusiveMinimum;
} });
const replyJsonSchema = { type: 'object', additionalProperties: false,
  required: [...json.required!, 'lesson'], properties: { ...json.properties, lesson: documentJsonSchema } };

export function createTutorRunner(): ProviderRunner {
  return new ProviderRunner({ resolveProvider: async id => {
    const match = (await detectProviders()).find(status => status.id === id);
    assert.ok(match, 'each installed provider must have a detection result');
    return match;
  } });
}

export function createGenerator(runner = createTutorRunner()): Generate {
  return async (turn, signal) => {
    const provider = turn.request.provider;
    if (provider === 'demo') return demoTurn(turn);
    const result = await runner.run({ provider, model: turn.preview.model, prompt: turn.preview.prompt,
      cacheKey: turn.preview.token, schema: replySchema, jsonSchema: replyJsonSchema, signal });
    return result.value;
  };
}

export function validateTurn(turn: PreparedTurn, reply: TutorReply) {
  const reject = (message: string) => { throw new DomainError('INVALID_TUTOR_REPLY', message + ' Retry this turn.'); };
  const blocks = reply.lesson.blocks;
  if (Buffer.byteLength(JSON.stringify(reply)) > 128 * 1024) reject('The response exceeds the lesson size limit.');
  const targetId = reply.recommendation?.targetId;
  if (targetId != null && !turn.nextConcepts.some(c => c.id === targetId)) reject('The suggested concept is outside your learning path.');
  const opening = turn.request.intent.kind === 'teach';
  const checkIndex = blocks.findIndex(block => block.type === 'check');
  if (checkIndex >= 0 && (!opening || checkIndex !== blocks.length - 1)) reject('The tutor placed a check outside the end of the opening lesson.');
  if (!blocks.some(b => ['prose', 'example', 'analogy', 'callout', 'diagram', 'code', 'comparison', 'trace'].includes(b.type))) {
    reject('The response is missing teaching content.');
  }
  if (opening && !blocks.some(b => b.type === 'prose' || b.type === 'example' || b.type === 'analogy')) {
    reject('The opening lesson needs an explanation.');
  }
  if (turn.response && (!reply.observation || !reply.recommendation || reply.assessment === null)) {
    reject('The tutor did not explain its assessment and next step.');
  }
  if (turn.response?.correct != null && reply.assessment !== turn.response.correct) reject('The assessment disagrees with the recorded answer key.');
  if (!turn.response && reply.assessment !== null) reject('Only an optional check can be assessed.');
}
