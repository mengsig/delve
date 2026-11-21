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
import { canRecommend, hasTransferredEvidence, loadMastery, publicMastery, requireMasteryRevision, saveMastery } from '../tutor/mastery';

export const address = z.strictObject({ workspaceId: z.uuid(), conceptId: z.int().positive(), depth: z.enum(DEPTHS) });
export const readerSchemas = {
  'reader:lesson': address,
  'reader:start-topic': z.strictObject({ workspaceId: z.uuid() }),
  'reader:message': address.extend({ text: z.string().trim().min(1).max(4000) }),
  'reader:skip': address.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) }),
};

function lessonState(db: Db, address: LessonAddress, loadDemo: boolean) {
  const context = lessonContext(db, address);
  const inherited = hasTransferredEvidence(db, context);
  const selected = selectLesson(db, context, loadDemo && !inherited);
  return { context, selected, mastery: loadMastery(db, context, selected, inherited) };
}

export function readLesson(db: Db, address: LessonAddress): ReaderLesson {
  const { selected, mastery } = lessonState(db, address, true);
  const { messages, earlierMessages } = readHistory(db, address);
  return { reused: mastery.stage === 'understood', blocks: selected.document ? publicBlocks(selected.document) : [],
    revision: selected.revision, invalidLatest: selected.invalidLatest, source: selected.source, mastery: publicMastery(mastery),
    messages: canRecommend(mastery) ? messages : messages.map(({ recommendation: _recommendation, ...message }) => message),
    earlierMessages };
}

function skipLesson(db: Db, request: ReaderContract['reader:skip']['request']): ReaderLesson {
  transaction(db, () => {
    const { context, mastery } = lessonState(db, request, false);
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
    'reader:skip': request => skipLesson(db, request),
    'reader:message': request => {
      const context = lessonContext(db, request);
      const selected = selectLesson(db, context);
      return addMessage(db, context, selected.id, request.text);
    },
  };
}
