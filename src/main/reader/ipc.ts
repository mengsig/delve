import { z } from 'zod';
import { DEPTHS } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import type { LessonAddress, ReaderContract, ReaderLesson } from '../../shared/reader';
import type { Db } from '../db/connection';
import { listWorkspaceConcepts, upsertConcept } from '../db/concepts';
import { getWorkspace } from '../db/workspaces';
import { isDemoWorkspace } from '../db/demo';
import { listEvidence, recordEvidence } from '../db/evidence';
import { addMessage, readHistory } from './conversation';
import { publicBlocks } from './document';
import { lessonContext, selectLesson } from './stored-lesson';

export const address = z.strictObject({ workspaceId: z.uuid(), conceptId: z.int().positive(), depth: z.enum(DEPTHS) });
export const readerSchemas = {
  'reader:lesson': address,
  'reader:start-topic': z.strictObject({ workspaceId: z.uuid() }),
  'reader:message': address.extend({ text: z.string().trim().min(1).max(4000) }),
  'reader:answer': address.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/), option: z.int().min(0).max(11) }),
};

export function readLesson(db: Db, address: LessonAddress): ReaderLesson {
  const context = lessonContext(db, address);
  const reused = listEvidence(db, address.conceptId).some(e => e.depth === address.depth && e.status === 'demonstrated');
  const selected = selectLesson(db, context, !reused);
  return { reused, blocks: selected.document ? publicBlocks(selected.document) : [], revision: selected.revision,
    invalidLatest: selected.invalidLatest, source: selected.source,
    ...readHistory(db, address) };
}

export function answerCheck(db: Db, request: ReaderContract['reader:answer']['request']) {
  const context = lessonContext(db, request);
  const { document, revision } = selectLesson(db, context);
  const check = document?.blocks.find(block => block.type === 'check');
  if (!check || !document || revision !== request.revision) throw new DomainError('LESSON_CHANGED', 'Reopen the lesson to try its current check.');
  const choice = check.options?.[request.option];
  if (choice === undefined) throw new DomainError('INVALID_OPTION', 'Choose one of the displayed answers.');
  if (request.option !== check.expected) {
    const explanation = document.blocks.filter(block => block.type === 'prose').at(-1)?.text ?? context.summary;
    return { demonstrated: false, feedback: `Try another prediction. ${explanation}` };
  }
  if (listEvidence(db, context.conceptId).some(e => e.depth === context.depth && e.status === 'demonstrated')) {
    return { demonstrated: true, feedback: `Connection confirmed. You already have evidence at ${context.depth} depth.` };
  }
  recordEvidence(db, {
    workspaceId: context.workspaceId, conceptId: context.conceptId, depth: context.depth, snapshotId: context.snapshotId ?? undefined,
    status: 'demonstrated', source: 'check', note: check.prompt + ' — ' + choice,
  });
  return { demonstrated: true, feedback: `Connection learned. Evidence for ${context.title} at ${context.depth} depth is saved locally.` };
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
    'reader:answer': request => answerCheck(db, request),
    'reader:message': request => {
      const context = lessonContext(db, request);
      const selected = selectLesson(db, context);
      return addMessage(db, context, selected.id, request.text);
    },
  };
}
