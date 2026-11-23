import type { RepositoryContract } from './repository';
import type { ReaderContract, TutorContract } from './reader';
import type { AddWorkspaceInput, Depth, ProviderStatus, Workspace, WorkspaceList } from './domain';
import type { WorkspaceCoverage, WorkspaceGraph, WorkspaceHead } from './graph';
import type { LabContract } from './lab-ipc';
import type { GlobalKnowledgeGraph, ConnectionPreview, ConnectionResult } from './knowledge';
import type { ProviderId } from './domain';

/**
 * The one typed channel map shared by main, preload and renderer.
 * Adding a channel here forces a main handler (see src/main/ipc.ts).
 */
export interface IpcContract extends RepositoryContract, ReaderContract, TutorContract, LabContract {
  'workspaces:list': { request: null; response: WorkspaceList };
  'workspaces:add': { request: AddWorkspaceInput; response: Workspace };
  'workspaces:switch': { request: { id: string }; response: WorkspaceList };
  'workspaces:pick-folder': { request: null; response: string | null };
  'providers:detect': { request: null; response: ProviderStatus[] };
  'graph:read': { request: { workspaceId: string; includeChangeLessons?: boolean; depth?: Depth }; response: WorkspaceGraph };
  'workspaces:head': { request: { workspaceId: string }; response: WorkspaceHead };
  'knowledge:read': { request: { demo: true } | null; response: GlobalKnowledgeGraph };
  'knowledge:remove-link': { request: { id: number }; response: boolean };
  'connections:preview': { request: { provider: ProviderId; conceptId: number }; response: ConnectionPreview };
  'connections:run': { request: { token: string; consent: true }; response: ConnectionResult };
  'connections:cancel': { request: null; response: null };
  'progress:read': { request: null; response: WorkspaceCoverage[] };
  'evidence:reset': { request: { workspaceId: string; conceptId: number; depth: Depth }; response: boolean };
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request'];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response'];

// A Record keyed by IpcChannel makes the compiler reject a missing or extra channel.
const CHANNEL_FLAGS: Record<IpcChannel, true> = {
  'workspaces:list': true,
  'workspaces:add': true,
  'workspaces:switch': true,
  'workspaces:pick-folder': true,
  'workspaces:head': true,
  'providers:detect': true,
  'reader:lesson': true,
  'reader:start-topic': true,
  'tutor:preview': true,
  'tutor:preview-topic': true,
  'tutor:run': true,
  'tutor:cancel': true,
  'tutor:jobs': true,
  'tutor:dismiss-unreadable': true,
  'tutor:wait': true,
  'tutor:retry': true,
  'tutor:dismiss': true,
  'reader:message': true,
  'reader:skip': true,
  'reader:foundation': true,
  'graph:read': true,
  'knowledge:read': true,
  'knowledge:remove-link': true,
  'connections:preview': true,
  'connections:run': true,
  'connections:cancel': true,
  'progress:read': true,
  'evidence:reset': true,
  'repo:stage': true,
  'repo:attach': true,
  'repo:files': true,
  'repo:preview': true,
  'repo:generate': true,
  'repo:cancel': true,
  'repo:changes': true,
  'repo:history': true,
  'repo:detail': true,
  'repo:saved': true,
  'learn:pending': true,
  'learn:resolve': true,
  'lab:open': true,
  'lab:input': true,
  'lab:close': true,
};

export const IPC_CHANNELS = Object.freeze(Object.keys(CHANNEL_FLAGS) as IpcChannel[]);

export interface IpcError {
  code: string;
  message: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && (IPC_CHANNELS as readonly string[]).includes(value);
}

/** The API the preload exposes on `window.delve`. */
export interface DelveApi {
  droppedPath(file: File): string;
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>>;
}
