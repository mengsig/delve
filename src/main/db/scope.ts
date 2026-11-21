import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import { getConcept } from './concepts';
import type { Db } from './connection';

export interface Scope {
  workspaceId: string | null;
  snapshotId: number | null;
}

/**
 * Checks that a record about `conceptId` is attributed consistently: a local concept only to its
 * own workspace, and a snapshot only to the workspace it was taken of. Returns the effective scope.
 */
export function resolveScope(db: Db, conceptId: number, workspaceId?: string, snapshotId?: number): Scope {
  const concept = getConcept(db, conceptId);
  if (!concept) throw new DomainError('CONCEPT_NOT_FOUND', `Concept ${conceptId} does not exist.`);
  if (!concept.portable && workspaceId !== undefined && workspaceId !== concept.workspaceId) {
    throw new DomainError('SCOPE_MISMATCH', `"${concept.title}" belongs to another workspace.`);
  }
  const effectiveWorkspace = workspaceId ?? concept.workspaceId;
  if (snapshotId === undefined) return { workspaceId: effectiveWorkspace, snapshotId: null };
  const snapshot = db.prepare('SELECT workspace_id FROM snapshots WHERE id = ?').get(snapshotId) as { workspace_id: string } | undefined;
  if (!snapshot) throw new DomainError('SNAPSHOT_NOT_FOUND', `Snapshot ${snapshotId} does not exist.`);
  if (snapshot.workspace_id !== effectiveWorkspace) {
    throw new DomainError('SCOPE_MISMATCH', `Snapshot ${snapshotId} was taken of a different workspace.`);
  }
  assert.ok(effectiveWorkspace !== null, 'a snapshot always has a workspace');
  return { workspaceId: effectiveWorkspace, snapshotId };
}
