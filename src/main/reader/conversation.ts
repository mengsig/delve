import assert from 'node:assert/strict';
import { z } from 'zod';
import type { LessonAddress, ReaderMessage } from '../../shared/reader';
import { nowIso, transaction, type Db } from '../db/connection';
import { demoReply, type LessonContext } from './demo';
import { documentSchema, publicBlocks, type Document } from './document';

export const recommendationSchema = z.strictObject({
  targetId: z.int().positive().nullable().optional(),
  action: z.string().trim().min(1).max(500), reason: z.string().trim().min(1).max(1500),
});
export const observationSchema = z.string().trim().min(1).max(1500);
const messageBody = z.union([
  z.string().transform(text => ({ text })),
  z.object({ text: z.string(), lesson: documentSchema.optional(), observation: observationSchema.optional(),
    recommendation: recommendationSchema.optional() }),
]);
const historyLimit = 80;

interface TranscriptEntry {
  role: ReaderMessage['role'];
  text: string;
  lesson?: Document;
  observation?: string;
  recommendation?: ReaderMessage['recommendation'];
}

function decodeMessage(row: Record<string, unknown>): ReaderMessage {
  assert.ok(typeof row.id === 'number' && typeof row.body === 'string');
  assert.ok(row.role === 'learner' || row.role === 'tutor' || row.role === 'system');
  const parsed = messageBody.safeParse(JSON.parse(row.body));
  const entry: Omit<TranscriptEntry, 'role'> = parsed.success ? parsed.data : { text: 'This saved message has an unsupported format.' };
  return { id: row.id, role: row.role, text: entry.text, blocks: entry.lesson && publicBlocks(entry.lesson),
    observation: entry.observation, recommendation: entry.recommendation };
}

export function readHistory(db: Db, { workspaceId, conceptId, depth }: LessonAddress) {
  const rows = db.prepare(`SELECT m.id, m.role, m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN lessons l ON l.id = c.lesson_id
    WHERE c.workspace_id = ? AND c.concept_id = ? AND coalesce(c.depth, l.depth) = ?
    ORDER BY m.id DESC LIMIT ?`).all(workspaceId, conceptId, depth, historyLimit + 1);
  const messages = rows.slice(0, historyLimit).reverse().map(decodeMessage);
  return { messages, earlierMessages: rows.length > historyLimit };
}

export function appendEntries(db: Db, context: LessonContext, lessonId: number | null, entries: TranscriptEntry[]): ReaderMessage[] {
  assert.ok(db.isTransaction, 'the learner and tutor turns must commit together');
  assert.ok(entries.length >= 1 && entries.length <= 2, 'a turn records at most one exchange');
  const now = nowIso();
  const row = db.prepare(`INSERT INTO conversations (workspace_id, concept_id, depth, lesson_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, concept_id, depth) DO UPDATE SET
    updated_at = excluded.updated_at, lesson_id = excluded.lesson_id RETURNING id`)
    .get(context.workspaceId, context.conceptId, context.depth, lessonId, context.title, now, now);
  assert.ok(row && typeof row.id === 'number', 'the turn must have a conversation');
  const conversationId = row.id;
  const insert = db.prepare('INSERT INTO messages (conversation_id, role, body, created_at) VALUES (?, ?, ?, ?)');
  return entries.map(({ role, ...body }) => {
    const hasLab = role === 'tutor' && body.lesson?.blocks.some(block => block.type === 'environment');
    const saved = hasLab ? { ...body, labSnapshotId: context.snapshotId } : body;
    const result = insert.run(conversationId, role, JSON.stringify(saved), now);
    assert.equal(result.changes, 1);
    return { role, text: body.text, id: Number(result.lastInsertRowid), blocks: body.lesson && publicBlocks(body.lesson),
      recommendation: body.recommendation, observation: body.observation };
  });
}

export function addMessage(db: Db, context: LessonContext, lessonId: number | null, text: string): ReaderMessage[] {
  assert.ok(text.trim().length > 0 && text.length <= 4000, 'message must fit the composer');
  const entries: TranscriptEntry[] = [{ role: 'learner', text }];
  if (context.demo) entries.push({ role: 'tutor', text: demoReply(context, text) });
  return transaction(db, () => appendEntries(db, context, lessonId, entries));
}
