import type { IpcChannel, IpcRequest, IpcResponse } from '../../shared/ipc';

export class IpcCallError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IpcCallError';
    this.code = code;
  }
}

/** Calls main over the preload bridge; a failed result becomes a thrown IpcCallError. */
export async function call<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> {
  if (typeof window.delve?.invoke !== 'function') throw new IpcCallError('NO_BRIDGE', 'The Delve preload bridge is missing.');
  const result = await window.delve.invoke(channel, request);
  if (!result.ok) throw new IpcCallError(result.error.code, result.error.message);
  return result.value;
}
