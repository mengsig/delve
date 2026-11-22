import { z } from 'zod';
import { PROVIDER_IDS } from '../../shared/domain';
import { CHECK_ANSWER_LIMIT } from '../../shared/lesson-blocks';
import { address } from '../reader/ipc';

export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const tutorRequest = address.extend({ provider: z.enum([...PROVIDER_IDS, 'demo']), intent: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('teach') }),
  z.strictObject({ kind: z.literal('review'), revision: digest }),
  z.strictObject({ kind: z.literal('adapt'), revision: digest }),
  z.strictObject({ kind: z.literal('ask'), text: z.string().trim().min(1).max(4000) }),
  z.strictObject({ kind: z.literal('answer'), revision: digest, answer: z.int().min(0).max(3), reasoning: z.string().max(CHECK_ANSWER_LIMIT).optional() }),
]) });
