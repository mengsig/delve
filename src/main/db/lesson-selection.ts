import { createHash } from 'node:crypto';
import { documentSchema, type Document } from '../reader/document';

const MAX_DOCUMENT_BYTES = 512 * 1024;

export const boundedLessonBody = `CASE WHEN l.schema_version = 'delve.lesson/1'
  AND length(CAST(l.body AS BLOB)) <= ${MAX_DOCUMENT_BYTES} THEN l.body END`;

export function lessonScopeSql(concepts: string, depth: string, workspace: string, snapshot: string, demo: string): string {
  return `l.concept_id IN (${concepts}) AND l.depth = ${depth} AND (l.workspace_id = ${workspace} OR l.workspace_id IS NULL)
    AND (l.snapshot_id IS NULL OR l.snapshot_id = ${snapshot}) AND (l.provider <> 'demo' OR ${demo} = 1)`;
}

export const lessonOrderSql = 'ORDER BY l.created_at DESC, l.id DESC';

export function decodeSavedDocument(version: unknown, body: unknown): Document | null {
  if (version !== 'delve.lesson/1' || typeof body !== 'string' || Buffer.byteLength(body) > MAX_DOCUMENT_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const result = documentSchema.safeParse(json);
  return result.success ? result.data : null;
}

export function lessonRevision(id: number, body: string): string {
  return createHash('sha256').update(String(id)).update(':').update(body).digest('hex');
}
