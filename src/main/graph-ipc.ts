import { DomainError } from '../shared/errors';
import type { Db } from './db/connection';
import { isDemoWorkspace } from './db/demo';
import { resetEvidence } from './db/evidence';
import { readWorkspaceCoverage, readWorkspaceGraph } from './db/graph';
import { deleteTransferLink, getGlobalKnowledgeGraph } from './db/knowledge';
import { readLearningProgress } from './db/learning-progress';
import { getWorkspace } from './db/workspaces';
import type { IpcHandlers } from './ipc';
import { readWorkspaceHead } from './repository/workspace-head';

export function graphHandlers(db: Db, cacheRoot: string): Pick<IpcHandlers,
  'graph:read' | 'workspaces:head' | 'knowledge:read' | 'knowledge:remove-link' | 'progress:read' | 'evidence:reset'> {
  return {
    'graph:read': ({ workspaceId, includeChangeLessons, depth }) => {
      const graph = readWorkspaceGraph(db, workspaceId, includeChangeLessons);
      if (depth === undefined) return graph;
      try {
        return { ...graph, progress: readLearningProgress(db, graph, depth) };
      } catch (error) {
        console.error('[progress] Could not read the workspace learning record', error);
        return graph;
      }
    },
    'workspaces:head': ({ workspaceId }) => {
      const workspace = getWorkspace(db, workspaceId);
      if (!workspace) throw new DomainError('WORKSPACE_NOT_FOUND', 'That workspace no longer exists.');
      return readWorkspaceHead(workspace, cacheRoot, isDemoWorkspace(db, workspaceId));
    },
    'knowledge:read': () => getGlobalKnowledgeGraph(db),
    'knowledge:remove-link': ({ id }) => deleteTransferLink(db, id),
    'progress:read': () => readWorkspaceCoverage(db),
    'evidence:reset': ({ workspaceId, conceptId, depth }) => resetEvidence(db, conceptId, { workspaceId, depth }) === 1,
  };
}
