import assert from 'node:assert/strict';
import { z } from 'zod';
import type { LessonAddress, ReaderMessage } from '../../shared/reader';
import { nowIso, transaction, type Db } from '../db/connection';
import { demoReply, type LessonContext } from './demo';

const messageBody = z.union([z.string(), z.object({ text: z.string() }).transform(body => body.text)]);
const historyLimit = 80;

export function readHistory(db: Db, { workspaceId, conceptId, depth }: LessonAddress) {
  const rows = db.prepare(`SELECT m.id, m.role, m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN lessons l ON l.id = c.lesson_id
    WHERE c.workspace_id = ? AND c.concept_id = ? AND coalesce(c.depth, l.depth) = ?
    ORDER BY m.id DESC LIMIT ?`).all(workspaceId, conceptId, depth, historyLimit + 1);
  const earlierMessages = rows.length > historyLimit;
  const messages: ReaderMessage[] = rows.slice(0, historyLimit).reverse().map(row => {
    assert.ok(typeof row.id === 'number' && typeof row.body === 'string');
    assert.ok(row.role === 'learner' || row.role === 'tutor' || row.role === 'system');
    const body = messageBody.safeParse(JSON.parse(row.body));
    return { id: row.id, role: row.role, text: body.success ? body.data : 'This saved message has an unsupported format.' };
  });
  return { messages, earlierMessages };
}

export function addMessage(db: Db, context: LessonContext, lessonId: number | null, text: string): ReaderMessage[] {
  const { workspaceId, conceptId, depth } = context;
  assert.ok(text.trim().length > 0 && text.length <= 4000, 'message must fit the composer');
  return transaction(db, () => {
    const now = nowIso();
    const row = db.prepare(`INSERT INTO conversations (workspace_id, concept_id, depth, lesson_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, concept_id, depth) DO UPDATE SET
      updated_at = excluded.updated_at, lesson_id = excluded.lesson_id RETURNING id`)
      .get(workspaceId, conceptId, depth, lessonId, context.title, now, now);
    assert.ok(row && typeof row.id === 'number', 'the message must have a conversation');
    const conversationId = row.id;
    const insert = db.prepare('INSERT INTO messages (conversation_id, role, body, created_at) VALUES (?, ?, ?, ?)');
    const store = (role: ReaderMessage['role'], text: string): ReaderMessage => {
      const result = insert.run(conversationId, role, JSON.stringify({ text }), now);
      assert.equal(result.changes, 1);
      return { role, text, id: Number(result.lastInsertRowid) };
    };
    const messages = [store('learner', text)];
    if (context.demo) messages.push(store('tutor', demoReply(context, text)));
    return messages;
  });
}
