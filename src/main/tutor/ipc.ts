import { z } from 'zod';
import { DEPTHS, PROVIDER_IDS } from '../../shared/domain';
import { CHECK_ANSWER_LIMIT } from '../../shared/lesson-blocks';
import type { Db } from '../db/connection';
import { address } from '../reader/ipc';
import { prepareTurn, previewNewTopic } from './prompt';
import type { TutorSession } from './session';
import type { IpcHandlers } from '../ipc';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const answer = z.union([z.int().min(0).max(11), z.string().trim().min(1).max(CHECK_ANSWER_LIMIT)]);
const request = address.extend({ provider: z.enum([...PROVIDER_IDS, 'demo']), intent: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('teach') }),
  z.strictObject({ kind: z.literal('ask'), text: z.string().trim().min(1).max(4000) }),
  z.strictObject({ kind: z.literal('answer'), revision: digest, answer }),
]) });
export const tutorSchemas = {
  'tutor:preview-topic': z.strictObject({ title: z.string().trim().min(1).max(120), depth: z.enum(DEPTHS), provider: z.enum(PROVIDER_IDS) }),
  'tutor:preview': request,
  'tutor:run': request.extend({ token: digest, requestId: z.uuid() }),
  'tutor:cancel': z.strictObject({ requestId: z.uuid() }),
};

export function tutorHandlers(db: Db, session: TutorSession): Pick<IpcHandlers, keyof typeof tutorSchemas> {
  return {
    'tutor:preview-topic': previewNewTopic,
    'tutor:preview': request => prepareTurn(db, request).preview,
    'tutor:run': request => session.run(request),
    'tutor:cancel': ({ requestId }) => session.cancel(requestId),
  };
}
