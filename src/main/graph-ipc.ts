import type { Db } from './db/connection';
import { resetEvidence } from './db/evidence';
import { readWorkspaceCoverage, readWorkspaceGraph } from './db/graph';
import type { IpcHandlers } from './ipc';

export function graphHandlers(db: Db): Pick<IpcHandlers, 'graph:read' | 'progress:read' | 'evidence:reset'> {
  return {
    'graph:read': ({ workspaceId }) => readWorkspaceGraph(db, workspaceId),
    'progress:read': () => readWorkspaceCoverage(db),
    'evidence:reset': ({ workspaceId, conceptId, depth }) => resetEvidence(db, conceptId, { workspaceId, depth }) === 1,
  };
}
