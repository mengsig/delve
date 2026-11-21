import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../shared/errors';
import { defaultPack, initialState, packContracts, packStateSchema, transition, type PackState } from '../../shared/instruments';
import type { LabContract } from '../../shared/lab-ipc';
import type { LabConfig } from '../../shared/lab-config';
import type { LessonAddress } from '../../shared/reader';
import { transaction, type Db } from '../db/connection';
import { listEvidence, recordEvidenceInTransaction } from '../db/evidence';
import { readWorkspaceGraph } from '../db/graph';
import { listWorkspaces } from '../db/workspaces';
import { appendEntries } from '../reader/conversation';
import { documentSchema, type Document } from '../reader/document';
import { readLesson } from '../reader/ipc';
import { lessonContext, selectLesson } from '../reader/stored-lesson';

type OpenRequest = LabContract['lab:open']['request'];
type Assessment = { demonstrated: boolean; observation: string; action: string; reason: string; targetKey?: string };
type Session = { request: OpenRequest; config: LabConfig; state: PackState | null; seq: number; expires: number; events: number[] };
const assessmentSchema = z.strictObject({ demonstrated: z.boolean(), observation: z.string().trim().min(1).max(1500),
  action: z.string().trim().min(1).max(500), reason: z.string().trim().min(1).max(1500), targetKey: z.string().min(1).max(1024).optional() });
const TTL = 30 * 60 * 1000;

function fail(message: string): never { throw new DomainError('LAB_UNAVAILABLE', message); }

function active(db: Db, address: LessonAddress): void {
  if (listWorkspaces(db).activeId !== address.workspaceId) fail('Switch to this workspace to use its activity.');
}

function messageDocument(db: Db, request: OpenRequest): Document {
  const row = db.prepare(`SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ? AND c.workspace_id = ? AND c.concept_id = ? AND c.depth = ? AND m.role = 'tutor'
    AND length(CAST(m.body AS BLOB)) <= 524288`).get(request.messageId, request.workspaceId, request.conceptId, request.depth);
  if (!row || typeof row.body !== 'string') return fail('This activity is no longer available.');
  let raw: unknown;
  try { raw = JSON.parse(row.body); } catch { return fail('This activity has an invalid saved message.'); }
  const parsed = z.object({ lesson: documentSchema }).safeParse(raw);
  if (!parsed.success) return fail('This activity has an invalid saved lesson.');
  return parsed.data.lesson;
}

function resolveActivity(db: Db, request: OpenRequest) {
  active(db, request);
  const context = lessonContext(db, request);
  const selected = selectLesson(db, context);
  if (selected.revision !== request.revision) return fail('The lesson changed. Reopen this activity.');
  const document = request.messageId === null ? selected.document : messageDocument(db, request);
  const block = document?.blocks[request.blockIndex];
  if (!block || block.type !== 'environment') return fail('This activity is no longer available.');
  const config = block.config ?? (block.pack ? defaultPack(block.pack) : null);
  if (!config) return fail('This activity is not supported.');
  if (config.pack === 'bundle@1') {
    const digest = createHash('sha256').update(config.bundle.source, 'utf8').digest('hex');
    if (digest !== config.bundle.sha256) return fail('This activity failed its integrity check.');
  }
  return { config, context, lessonId: selected.id };
}

function saveAssessment(db: Db, request: OpenRequest, assessment: Assessment): void {
  const { context, lessonId } = resolveActivity(db, request);
  const prior = listEvidence(db, context.conceptId).find(e => e.depth === context.depth);
  const foreignOrigin = prior?.workspaceId && prior.workspaceId !== context.workspaceId;
  if (!foreignOrigin) recordEvidenceInTransaction(db, { workspaceId: context.workspaceId, conceptId: context.conceptId,
    depth: context.depth, snapshotId: context.snapshotId ?? undefined, status: assessment.demonstrated ? 'demonstrated' : 'partial',
    source: 'environment', note: assessment.observation });
  const target = assessment.targetKey ? readWorkspaceGraph(db, context.workspaceId).concepts.find(c => c.key === assessment.targetKey) : undefined;
  appendEntries(db, context, lessonId, [{ role: 'system', text: foreignOrigin
    ? 'Activity practice recorded; existing evidence remains in its original workspace.' : 'Activity practice recorded.',
  observation: assessment.observation, recommendation: { action: assessment.action, reason: assessment.reason, targetId: target?.id ?? null } }]);
}

function boundedInput(input: unknown): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(input); } catch { return fail('Invalid activity input.'); }
  if (!encoded || Buffer.byteLength(encoded) > 8192) fail('Activity input is too large or invalid.');
}

export function labHandlers(db: Db): { [C in keyof LabContract]: (request: LabContract[C]['request']) => LabContract[C]['response'] } {
  const sessions = new Map<string, Session>();
  return {
    'lab:open': request => {
      const now = Date.now();
      for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id);
      if (sessions.size >= 200) return fail('Too many activities are open. Close one and retry.');
      const { config } = resolveActivity(db, request);
      const state = config.pack === 'bundle@1' ? null : packStateSchema.parse(initialState(config));
      const id = randomUUID();
      sessions.set(id, { request, config, state, seq: 0, expires: now + TTL, events: [] });
      return { session: id, config, state };
    },
    'lab:input': ({ session: id, seq, input }) => {
      const session = sessions.get(id);
      const now = Date.now();
      if (!session || session.expires <= now) { sessions.delete(id); return fail('This activity session expired.'); }
      if (seq !== session.seq + 1) return fail('Activity input is out of order.');
      session.events = session.events.filter(time => time > now - 60000);
      if (session.events.length >= 120) return fail('Activity input rate exceeded.');
      session.events.push(now);
      const current = resolveActivity(db, session.request);
      if (JSON.stringify(current.config) !== JSON.stringify(session.config)) return fail('The activity changed. Reopen it.');
      if (session.config.pack === 'bundle@1' || !session.state) return fail('This activity runs as practice only.');
      boundedInput(input);
      const event = packContracts[session.config.pack].inputSchema.safeParse(input);
      if (!event.success) return fail('This activity input is invalid.');
      const result = transition(session.config, session.state, event.data);
      const state = packStateSchema.parse(result.state);
      assert.equal(state.pack, session.config.pack, 'transition must preserve the pack');
      const assessment = result.assessment === undefined ? undefined : assessmentSchema.parse(result.assessment);
      if (assessment) transaction(db, () => saveAssessment(db, session.request, assessment));
      session.state = state;
      session.seq = seq;
      return assessment ? { state, lesson: readLesson(db, session.request) } : { state };
    },
    'lab:close': ({ session }) => sessions.delete(session),
  };
}
