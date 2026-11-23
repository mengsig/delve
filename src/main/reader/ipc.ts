import { z } from 'zod';
import { DEPTHS } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import type { LessonAddress, ReaderContract, ReaderLesson } from '../../shared/reader';
import { transaction, type Db } from '../db/connection';
import { listWorkspaceConcepts, upsertConcept } from '../db/concepts';
import { getWorkspace } from '../db/workspaces';
import { isDemoWorkspace } from '../db/demo';
import { addMessage, readHistory } from './conversation';
import { publicBlocks } from './document';
import { lessonContext, selectLesson } from './stored-lesson';
import { canRecommend, hasVerifiedMastery, loadMastery, publicMastery, requireMasteryRevision, saveMastery } from '../tutor/mastery';
import { answerFoundation, readFoundation } from '../tutor/foundation-progress';

export const address = z.strictObject({ workspaceId: z.uuid(), conceptId: z.int().positive(), depth: z.enum(DEPTHS) });
export const readerSchemas = {
  'reader:lesson': address,
  'reader:start-topic': z.strictObject({ workspaceId: z.uuid() }),
  'reader:message': address.extend({ text: z.string().trim().min(1).max(4000) }),
  'reader:skip': address.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) }),
  'reader:foundation': address.extend({
    lessonId: z.int().positive().optional(),
    decision: z.strictObject({ revision: z.string().regex(/^[a-f0-9]{64}$/), answer: z.int().min(0).max(3).nullable() }).optional(),
  }),
};

function lessonState(db: Db, address: LessonAddress, loadDemo: boolean) {
  const context = lessonContext(db, address);
  const inherited = hasVerifiedMastery(db, context);
  const selected = selectLesson(db, context, loadDemo && !inherited);
  return { context, selected, mastery: loadMastery(db, context, selected, inherited) };
}

function foundationLessonId(db: Db, context: ReturnType<typeof lessonContext>, latest: number | null, lessonId?: number) {
  if (lessonId === undefined || lessonId === latest) return latest;
  const row = db.prepare(`SELECT 1 FROM lessons WHERE id = ? AND workspace_id = ?
    AND concept_id = ? AND depth = ? AND snapshot_id IS ?`)
    .get(lessonId, context.workspaceId, context.canonicalConceptId, context.depth, context.snapshotId);
  if (!row) throw new DomainError('LESSON_CHANGED', 'Reopen the change to see the current lesson.');
  return lessonId;
}

export function readLesson(db: Db, address: LessonAddress): ReaderLesson {
  const { context, selected, mastery } = lessonState(db, address, true);
  const foundation = readFoundation(db, context, selected.id);
  const { messages, earlierMessages } = readHistory(db, context);
  return { reused: mastery.stage === 'understood', blocks: !foundation && selected.document ? publicBlocks(selected.document) : [],
    revision: selected.revision, invalidLatest: selected.invalidLatest, source: selected.source, mastery: publicMastery(mastery),
    ...(foundation ? { foundation } : {}),
    messages: canRecommend(mastery) ? messages : messages.map(({ recommendation: _recommendation, ...message }) => message),
    earlierMessages };
}

function skipLesson(db: Db, request: ReaderContract['reader:skip']['request']): ReaderLesson {
  transaction(db, () => {
    const { context, selected, mastery } = lessonState(db, request, false);
    if (readFoundation(db, context, selected.id)) throw new DomainError('FOUNDATION_PENDING', 'Finish or skip the foundations first.');
    requireMasteryRevision(mastery, request.revision, ['teaching', 'checking', 'review']);
    saveMastery(db, context, mastery, { stage: 'skipped', check: null });
  });
  return readLesson(db, request);
}

type Handlers = { [C in keyof ReaderContract]: (request: ReaderContract[C]['request']) => ReaderContract[C]['response'] };

export function readerHandlers(db: Db): Handlers {
  return {
    'reader:start-topic': ({ workspaceId }) => {
      const workspace = getWorkspace(db, workspaceId);
      if (workspace?.kind !== 'topic' || isDemoWorkspace(db, workspaceId)) {
        throw new DomainError('INVALID_TOPIC', 'Choose a topic you added to your atlas.');
      }
      const mapped = listWorkspaceConcepts(db, workspaceId);
      if (mapped.length) {
        const existing = mapped.find(c => c.key === 'ws/' + workspaceId + '/topic' && c.title === workspace.name);
        if (!existing) throw new DomainError('TOPIC_MAPPED', 'Choose a concept from the existing atlas.');
        return existing.id;
      }
      return upsertConcept(db, { key: 'topic', workspaceId, title: workspace.name, portable: false }).id;
    },
    'reader:lesson': request => readLesson(db, request),
    'reader:foundation': request => {
      const { context, selected } = lessonState(db, request, false);
      const lessonId = foundationLessonId(db, context, selected.id, request.lessonId);
      return request.decision ? answerFoundation(db, context, lessonId, request.decision)
        : { step: readFoundation(db, context, lessonId) };
    },
    'reader:skip': request => skipLesson(db, request),
    'reader:message': request => {
      const context = lessonContext(db, request);
      const selected = selectLesson(db, context);
      return addMessage(db, context, selected.id, request.text);
    },
  };
}
