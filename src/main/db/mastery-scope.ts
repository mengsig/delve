import { createHash } from 'node:crypto';
import type { LessonContext } from '../reader/demo';

export function masteryScope(
  context: Pick<LessonContext, 'workspaceId' | 'conceptId' | 'depth' | 'snapshotId'>, revision: string | null,
): string {
  const { workspaceId, conceptId, depth, snapshotId } = context;
  return createHash('sha256').update(JSON.stringify([workspaceId, conceptId, depth, snapshotId, revision])).digest('hex');
}
