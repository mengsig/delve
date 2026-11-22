import { repoSchemas } from './repository/schemas';
import { tutorSchemas } from './tutor/ipc';
import { readerSchemas } from './reader/ipc';
import { labSchemas } from './environment/ipc';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DEPTHS } from '../shared/domain';
import { IPC_CHANNELS, type IpcChannel, type IpcError, type IpcRequest, type IpcResponse, type IpcResult } from '../shared/ipc';
import { DomainError } from '../shared/errors';
import { connectionSchemas } from './connections/session';

const text = z.string().max(4096);
const workspaceId = z.uuid();

/** Runtime validation of every request the renderer sends; the renderer is not trusted. */
export const REQUEST_SCHEMAS: { [C in IpcChannel]: z.ZodType<IpcRequest<C>> } = {
  'workspaces:list': z.null(),
  'workspaces:add': z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('git'), path: text }),
    z.strictObject({ kind: z.literal('github'), owner: text, repo: text }),
    z.strictObject({ kind: z.literal('topic'), title: text }),
  ]),
  'workspaces:switch': z.strictObject({ id: workspaceId }),
  'workspaces:pick-folder': z.null(),
  'workspaces:head': z.strictObject({ workspaceId }),
  'providers:detect': z.null(),
  ...readerSchemas,
  ...repoSchemas,
  ...tutorSchemas,
  ...labSchemas,
  'graph:read': z.strictObject({ workspaceId, includeChangeLessons: z.boolean().optional(), depth: z.enum(DEPTHS).optional() }),
  'knowledge:read': z.null(),
  'knowledge:remove-link': z.strictObject({ id: z.int().positive() }),
  ...connectionSchemas,
  'connections:cancel': z.null(),
  'progress:read': z.null(),
  'evidence:reset': z.strictObject({ workspaceId, conceptId: z.int().positive(), depth: z.enum(DEPTHS) }),
};

export type IpcHandlers = { [C in IpcChannel]: (request: IpcRequest<C>) => Promise<IpcResponse<C>> | IpcResponse<C> };

function toIpcError(error: unknown): IpcError {
  if (error instanceof DomainError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) return { code: 'INVALID_REQUEST', message: z.prettifyError(error) };
  return { code: 'INTERNAL', message: 'Something went wrong in Delve. The details are in the log.' };
}

/** Validates a raw request, runs its handler and turns failures into a typed error result. */
export async function dispatch<C extends IpcChannel>(handlers: IpcHandlers, channel: C, raw: unknown): Promise<IpcResult<IpcResponse<C>>> {
  assert.ok(IPC_CHANNELS.includes(channel), `unknown channel ${channel}`);
  try {
    const request = REQUEST_SCHEMAS[channel].parse(raw ?? null) as IpcRequest<C>;
    const handler = handlers[channel] as (request: IpcRequest<C>) => Promise<IpcResponse<C>> | IpcResponse<C>;
    return { ok: true, value: await handler(request) };
  } catch (error) {
    const ipcError = toIpcError(error);
    // Unexpected errors keep their stack in the main-process log; the renderer gets a safe message.
    if (ipcError.code === 'INTERNAL') console.error(`[ipc] ${channel} failed`, error);
    return { ok: false, error: ipcError };
  }
}

export interface IpcRegistrar {
  handle(channel: string, listener: (event: { senderFrame: { url: string; parent: unknown } | null }, raw: unknown) => Promise<unknown>): void;
}

/** Registers one handler per channel; requests from frames outside the app are refused. */
export function registerIpc(ipc: IpcRegistrar, handlers: IpcHandlers, isTrustedUrl: (url: string) => boolean, signal?: AbortSignal): void {
  assert.equal(Object.keys(handlers).length, IPC_CHANNELS.length, 'every channel needs exactly one handler');
  for (const channel of IPC_CHANNELS) {
    ipc.handle(channel, async (event, raw) => {
      const url = event.senderFrame?.url ?? '';
      if (event.senderFrame?.parent !== null || !isTrustedUrl(url)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Request from an untrusted frame.' } } satisfies IpcResult<never>;
      }
      if (signal?.aborted) {
        return { ok: false, error: { code: 'APP_CLOSING', message: 'Delve is closing.' } } satisfies IpcResult<never>;
      }
      return dispatch(handlers, channel, raw);
    });
  }
}
