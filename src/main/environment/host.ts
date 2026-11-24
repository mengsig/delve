import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assessmentSchema, type Assessment } from '../../shared/instruments/assessment';
import { manifestFor } from './manifest';
import { DomainError } from '../../shared/errors';
import { defaultPack, initialState, packContracts, packStateSchema, transition, type PackState } from '../../shared/instruments';
import { LAB_LIFETIME_MS, LAB_ACTION_LIMIT, type LabContract } from '../../shared/lab-ipc';
import type { LabConfig } from '../../shared/lab-config';
import type { LessonAddress } from '../../shared/reader';
import { transaction, type Db } from '../db/connection';
import { listEvidence, recordEvidenceInTransaction } from '../db/evidence';
import { listWorkspaceConcepts } from '../db/concepts';
import { isActiveWorkspace } from '../db/workspaces';
import { appendEntries } from '../reader/conversation';
import { documentSchema, type Document } from '../reader/document';
import { readLesson } from '../reader/ipc';
import { lessonContext, requestedLesson } from '../reader/stored-lesson';

type OpenRequest = LabContract['lab:open']['request'];
type Session = { id: string; request: OpenRequest; snapshotId: number | null; config: LabConfig; state: PackState | null; seq: number; expires: number; events: number[] };
function fail(message: string): never { throw new DomainError('LAB_UNAVAILABLE', message); }

function active(db: Db, address: LessonAddress): void {
  if (!isActiveWorkspace(db, address.workspaceId)) fail('Switch to this workspace to use its activity.');
}

function messageDocument(db: Db, request: OpenRequest, canonicalId: number, snapshotId: number | null): Document {
  const row = db.prepare(`SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = :message AND c.workspace_id = :workspace AND c.depth = :depth AND m.role = 'tutor'
    AND (c.concept_id = :concept OR c.concept_id IN
      (SELECT legacy_concept_id FROM concept_identity_links WHERE canonical_concept_id = :concept))
    AND (:lesson IS NULL OR m.pinned_lesson_id = :lesson) AND length(CAST(m.body AS BLOB)) <= 524288`)
    .get({ message: request.messageId, workspace: request.workspaceId, concept: canonicalId, depth: request.depth, lesson: request.lessonId ?? null });
  if (!row || typeof row.body !== 'string') return fail('This activity is no longer available.');
  let raw: unknown;
  try { raw = JSON.parse(row.body); } catch { return fail('This activity has an invalid saved message.'); }
  const parsed = z.object({ lesson: documentSchema, labSnapshotId: z.int().positive().nullable().optional() }).safeParse(raw);
  if (!parsed.success) return fail('This activity has an invalid saved lesson.');
  if ((parsed.data.labSnapshotId ?? null) !== snapshotId) return fail('This activity belongs to a different snapshot or has no snapshot binding.');
  return parsed.data.lesson;
}

function resolveActivity(db: Db, request: OpenRequest) {
  active(db, request);
  const context = lessonContext(db, request);
  const selected = requestedLesson(db, context);
  if (selected.revision !== request.revision) return fail('The lesson changed. Reopen this activity.');
  const document = request.messageId === null ? selected.document : messageDocument(db, request, context.canonicalConceptId, context.snapshotId);
  const block = document?.blocks[request.blockIndex];
  if (!block || block.type !== 'environment') return fail('This activity is no longer available.');
  const config = block.config ?? (block.pack ? defaultPack(block.pack) : null);
  if (!config) return fail('This activity is not supported.');
  if (config.pack === 'bundle@1') {
    const digest = createHash('sha256').update(config.bundle.source, 'utf8').digest('hex');
    if (digest !== config.bundle.sha256) return fail('This activity failed its integrity check.');
  }
  return { config, context, lessonId: selected.id, fallback: block.fallback ?? context.summary };
}

function suggestedConcept(db: Db, workspaceId: string, demo: boolean, key?: string) {
  if (!key) return null;
  const keys = new Set([key, `ws/${workspaceId}/${key}`]);
  if (demo) keys.add(`ws/${workspaceId}/Demo:${key}`);
  return listWorkspaceConcepts(db, workspaceId).find(concept => keys.has(concept.key))?.id ?? null;
}

function saveAssessment(db: Db, activity: ReturnType<typeof resolveActivity>, assessment: Assessment): void {
  const { context, lessonId } = activity;
  const observation = assessment.observation + ' ' + assessment.reason;
  const prior = listEvidence(db, context.canonicalConceptId).find(e => e.depth === context.depth);
  const foreignOrigin = prior?.workspaceId && prior.workspaceId !== context.workspaceId;
  if (!foreignOrigin && prior?.status !== 'demonstrated' && assessment.status !== 'practice') recordEvidenceInTransaction(db, { workspaceId: context.workspaceId, conceptId: context.canonicalConceptId,
    depth: context.depth, snapshotId: context.snapshotId ?? undefined, status: 'partial',
    source: 'environment', note: observation });
  const targetId = suggestedConcept(db, context.workspaceId, context.demo, assessment.targetKey);
  appendEntries(db, context, lessonId, [{ role: 'system', text: foreignOrigin
    ? 'Activity practice saved; your previous progress remains in its original workspace.' : 'Activity practice saved.',
  observation, recommendation: { action: assessment.action, reason: assessment.reason, targetId } }]);
}

export class LabHost {
  private current?: Session;

  constructor(private db: Db) {}

  open(request: OpenRequest): LabContract['lab:open']['response'] {
    const { config, fallback, context } = resolveActivity(this.db, request);
    const state = config.pack === 'bundle@1' ? null : packStateSchema.parse(initialState(config));
    const id = randomUUID();
    this.current = { id, request, snapshotId: context.snapshotId, config, state, seq: 0, expires: performance.now() + LAB_LIFETIME_MS, events: [] };
    return { session: id, manifest: manifestFor(config, fallback), state };
  }

  input({ session: id, seq, input }: LabContract['lab:input']['request']): LabContract['lab:input']['response'] {
    const session = this.current;
    if (!session || session.id !== id) return fail('This activity session expired.');
    const now = performance.now();
    if (now >= session.expires) { this.clear(); return fail('This activity session expired.'); }
    session.events = session.events.filter(time => time > now - 60000);
    if (session.events.length >= 120 || session.seq >= LAB_ACTION_LIMIT) {
      this.clear();
      return fail('Activity input budget exceeded.');
    }
    session.events.push(now);
    if (seq !== session.seq + 1) return fail('Activity input is out of order.');
    if (session.config.pack === 'bundle@1' || !session.state) return fail('This activity runs as practice only.');
    const event = packContracts[session.config.pack].inputSchema.safeParse(input);
    if (!event.success) return fail('This activity input is invalid.');
    const activity = resolveActivity(this.db, session.request);
    if (activity.context.snapshotId !== session.snapshotId) return fail('The activity snapshot changed. Reopen the instrument.');
    if (JSON.stringify(activity.config) !== JSON.stringify(session.config)) return fail('The activity changed. Reopen it.');
    const result = transition(session.config, session.state, event.data);
    const state = packStateSchema.parse(result.state);
    assert.equal(state.pack, session.config.pack, 'transition must preserve the pack');
    const assessment = result.assessment && assessmentSchema.parse(result.assessment);
    if (assessment) transaction(this.db, () => saveAssessment(this.db, activity, assessment));
    session.state = state;
    session.seq = seq;
    return assessment ? { state, lesson: readLesson(this.db, session.request) } : { state };
  }

  close({ session }: LabContract['lab:close']['request']): boolean {
    if (session !== this.current?.id) return false;
    this.clear();
    return true;
  }

  clear() { this.current = undefined; }
}
