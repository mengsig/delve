import assert from 'node:assert/strict';
import { z } from 'zod';
import { DomainError } from '../../shared/errors';
import { detectProviders } from '../providers/detect';
import { ProviderRunner } from '../providers/runner';
import { documentGenerationSchema, documentJsonSchema, documentSchema, type Document } from '../reader/document';
import { observationSchema, recommendationSchema } from '../reader/conversation';
import type { PreparedTurn } from './prompt';
import { demoTurn } from './sample';
import { assertFreshCheck, canRecommend, checkIn, nextGrade } from './mastery';

const metadata = z.strictObject({
  observation: observationSchema.nullable(),
  recommendation: recommendationSchema.extend({ targetId: z.int().positive().nullable() }).nullable(),
  assessment: z.boolean().nullable(),
});

export type TutorReply = z.infer<typeof metadata> & { lesson: Document; reasoningFeedback?: string };
export type Generate = (turn: PreparedTurn, signal: AbortSignal) => Promise<TutorReply>;

const replySchema = metadata.extend({ lesson: documentGenerationSchema });
const reasonedReply = replySchema.extend({ reasoningFeedback: observationSchema });
const json = z.toJSONSchema(metadata, { target: 'draft-7', override: ({ jsonSchema }) => {
  delete jsonSchema.minLength;
  delete jsonSchema.maxLength;
  delete jsonSchema.minimum;
  delete jsonSchema.maximum;
  delete jsonSchema.exclusiveMinimum;
} });
const replyJsonSchema = { type: 'object', additionalProperties: false,
  required: [...json.required!, 'lesson'], properties: { ...json.properties, lesson: documentJsonSchema } };

const reasonedJsonSchema = { ...replyJsonSchema, required: [...replyJsonSchema.required, 'reasoningFeedback'],
  properties: { ...replyJsonSchema.properties, reasoningFeedback: { type: 'string' } } };

export function createTutorRunner(detect: () => ReturnType<typeof detectProviders> = detectProviders): ProviderRunner {
  return new ProviderRunner({ resolveProvider: async id => {
    const match = (await detect()).find(status => status.id === id);
    assert.ok(match, 'each installed provider must have a detection result');
    return match;
  } });
}

export function createGenerator(runner = createTutorRunner()): Generate {
  return async (turn, signal) => {
    const provider = turn.request.provider;
    if (provider === 'demo') return demoTurn(turn);
    const reasoned = Boolean(turn.response?.reasoning?.trim());
    const result = await runner.run<TutorReply>({ provider, model: turn.preview.model ?? undefined, prompt: turn.preview.prompt,
      cacheKey: turn.preview.token, schema: reasoned ? reasonedReply : replySchema, jsonSchema: reasoned ? reasonedJsonSchema : replyJsonSchema, signal });
    return result.value;
  };
}

function invalidReply(message: string): never {
  throw new DomainError('INVALID_TUTOR_REPLY', message + ' Retry this turn.');
}

export function validateTurn(turn: PreparedTurn, output: TutorReply): TutorReply {
  const { intent } = turn.request;
  if (Buffer.byteLength(JSON.stringify(output)) > 128 * 1024) invalidReply('The response exceeds the lesson size limit.');
  const parsed = metadata.extend({ lesson: documentSchema, reasoningFeedback: observationSchema.optional() }).safeParse(output);
  if (!parsed.success) invalidReply('The tutor returned invalid teaching content or feedback.');
  const reply = parsed.data;
  if (Boolean(turn.response?.reasoning?.trim()) !== Boolean(reply.reasoningFeedback)) {
    invalidReply('The tutor must address the learner’s supplied reasoning separately from the choice.');
  }
  const blocks = reply.lesson.blocks;
  if (turn.needsDiagram && !blocks.some(block => block.type === 'diagram' && block.nodes.length >= 2 && block.edges?.length)) {
    invalidReply('The tutor did not provide a diagram with connected nodes.');
  }
  const check = checkIn(reply.lesson);
  if (check && blocks.at(-1) !== check) invalidReply('The tutor placed a check outside the end of its response.');
  if (intent.kind === 'adapt') {
    if (!check || blocks.length !== 1 || reply.observation !== null || reply.assessment !== null || reply.recommendation !== null) {
      invalidReply('Adaptation must replace only the active check.');
    }
    assertFreshCheck(turn.mastery, check);
    return reply;
  }
  if (!blocks.some(b => ['prose', 'example', 'analogy', 'callout', 'diagram', 'code', 'comparison', 'trace'].includes(b.type))) {
    invalidReply('The response is missing teaching content.');
  }
  if (intent.kind === 'teach' && !blocks.some(b => b.type === 'prose' || b.type === 'example' || b.type === 'analogy')) {
    invalidReply('The opening lesson needs an explanation.');
  }
  if (turn.response && (!reply.observation || reply.assessment === null)) invalidReply('The tutor did not explain its assessment.');
  if (turn.response && reply.assessment !== turn.response.correct) invalidReply('The assessment disagrees with the recorded answer key.');
  if (!turn.response && reply.assessment !== null) invalidReply('Only a submitted check answer can be assessed.');
  const afterGrade = turn.response ? nextGrade(turn.mastery, turn.response.correct) : null;
  const needsCheck = intent.kind === 'teach' || intent.kind === 'review' || afterGrade?.stage === 'checking';
  if (needsCheck && !check) invalidReply('The tutor did not provide the required check.');
  if (!needsCheck && check) invalidReply('The tutor placed a check outside the active lesson sequence.');
  if (check) assertFreshCheck(turn.mastery, check);
  if (reply.recommendation) {
    const allowed = afterGrade?.stage === 'understood' || intent.kind === 'ask' && canRecommend(turn.mastery);
    if (!allowed) invalidReply('The tutor recommended another step before the lesson was understood or skipped.');
    const targetId = reply.recommendation.targetId;
    if (targetId !== null && !turn.nextConcepts.some(c => c.id === targetId)) invalidReply('The suggested concept is outside your learning path.');
  }
  return reply;
}
