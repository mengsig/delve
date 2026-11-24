import { z } from 'zod';
import { DEPTHS, PROVIDER_IDS } from '../../shared/domain';
import type { Db } from '../db/connection';
import { prepareTurn, previewNewTopic } from './prompt';
import { digest, tutorRequest } from './request';
import { unreadableJobIdentity } from './jobs';
import type { TutorSession } from './session';
import type { IpcHandlers } from '../ipc';

const jobAddress = z.strictObject({ requestId: z.uuid() });
export const tutorSchemas = {
  'tutor:preview-topic': z.strictObject({ title: z.string().trim().min(1).max(120), depth: z.enum(DEPTHS), provider: z.enum(PROVIDER_IDS) }),
  'tutor:preview': tutorRequest,
  'tutor:run': tutorRequest.extend({ token: digest, requestId: z.uuid() }),
  'tutor:cancel': jobAddress,
  'tutor:jobs': z.null(),
  'tutor:wait': jobAddress,
  'tutor:retry': jobAddress.extend({ provider: tutorRequest.shape.provider }),
  'tutor:dismiss': jobAddress,
  'tutor:dismiss-unreadable': unreadableJobIdentity,
};

export function tutorHandlers(db: Db, session: TutorSession): Pick<IpcHandlers, keyof typeof tutorSchemas> {
  return {
    'tutor:preview-topic': request => previewNewTopic(db, request),
    'tutor:preview': request => prepareTurn(db, request).preview,
    'tutor:run': request => session.run(request),
    'tutor:cancel': ({ requestId }) => session.cancel(requestId),
    'tutor:jobs': () => session.jobs(),
    'tutor:wait': ({ requestId }) => session.wait(requestId),
    'tutor:retry': ({ requestId, provider }) => session.retry(requestId, provider),
    'tutor:dismiss': ({ requestId }) => session.dismiss(requestId),
    'tutor:dismiss-unreadable': identity => session.dismissUnreadable(identity),
  };
}
