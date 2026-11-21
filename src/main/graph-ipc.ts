import type { Db } from './db/connection';
import { resetEvidence } from './db/evidence';
import { readWorkspaceCoverage, readWorkspaceGraph } from './db/graph';
import { deleteTransferLink, getGlobalKnowledgeGraph } from './db/knowledge';
import type { IpcHandlers } from './ipc';

export function graphHandlers(db: Db): Pick<IpcHandlers, 'graph:read' | 'knowledge:read' | 'knowledge:remove-link' | 'progress:read' | 'evidence:reset'> {
  return {
    'graph:read': ({ workspaceId, includeChangeLessons }) => readWorkspaceGraph(db, workspaceId, includeChangeLessons),
    'knowledge:read': () => getGlobalKnowledgeGraph(db),
    'knowledge:remove-link': ({ id }) => deleteTransferLink(db, id),
    'progress:read': () => readWorkspaceCoverage(db),
    'evidence:reset': ({ workspaceId, conceptId, depth }) => resetEvidence(db, conceptId, { workspaceId, depth }) === 1,
  };
}
