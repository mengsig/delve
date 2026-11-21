import type { ReaderContract, TutorContract } from './reader';
import type { AddWorkspaceInput, Depth, ProviderStatus, Workspace, WorkspaceList } from './domain';
import type { WorkspaceCoverage, WorkspaceGraph } from './graph';

/**
 * The one typed channel map shared by main, preload and renderer.
 * Adding a channel here forces a main handler (see src/main/ipc.ts).
 */
export interface IpcContract extends ReaderContract, TutorContract {
  'workspaces:list': { request: null; response: WorkspaceList };
  'workspaces:add': { request: AddWorkspaceInput; response: Workspace };
  'workspaces:switch': { request: { id: string }; response: WorkspaceList };
  'workspaces:pick-folder': { request: null; response: string | null };
  'providers:detect': { request: null; response: ProviderStatus[] };
  'graph:read': { request: { workspaceId: string }; response: WorkspaceGraph };
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
  'providers:detect': true,
  'reader:lesson': true,
  'reader:start-topic': true,
  'tutor:preview': true,
  'tutor:run': true,
  'tutor:cancel': true,
  'reader:message': true,
  'reader:answer': true,
  'graph:read': true,
  'progress:read': true,
  'evidence:reset': true,
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
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>>;
}
