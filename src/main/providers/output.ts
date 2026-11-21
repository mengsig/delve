import assert from 'node:assert';
import { open, type FileHandle } from 'node:fs/promises';
import type { z } from 'zod';
import type { ProviderId } from '../../shared/domain';
import type { CaptureResult } from './process';
import { ProviderError, classifyText, failedError, invalidOutputError } from './errors';

function parseJson(provider: ProviderId, text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw invalidOutputError(provider, `${what} is not valid JSON`, cause);
  }
}

/** Classifies the diagnostic from a failed CLI exit. */
export function checkExit(provider: ProviderId, res: CaptureResult, model?: string): void {
  assert(res.code === null || Number.isInteger(res.code), 'exit code must be an integer or null');
  if (res.code === 0) return;
  const classified = classifyText(provider, `${res.stderr}\n${res.stdout}`, model);
  throw classified ?? failedError(provider, 'the request stopped before a response was ready. Try again or choose another provider.');
}

/** Extracts the structured payload from claude's single JSON result object. */
export function extractClaudePayload(res: CaptureResult, model?: string): unknown {
  const envelope = parseJson('claude', res.stdout, 'claude output');
  if (typeof envelope !== 'object' || envelope === null) throw invalidOutputError('claude', 'result is not an object');
  const obj = envelope as { is_error?: unknown; result?: unknown; structured_output?: unknown; errors?: unknown };
  if (obj.is_error === true) {
    const errors: unknown[] = Array.isArray(obj.errors) ? obj.errors : [];
    const text = [obj.result, ...errors].filter(item => typeof item === 'string').join('\n');
    throw classifyText('claude', `${res.stderr}\n${text}`, model) ?? failedError('claude', 'the request could not be completed. Try again or choose another provider.');
  }
  if (obj.structured_output !== undefined && obj.structured_output !== null) return obj.structured_output;
  if (typeof obj.result !== 'string') throw invalidOutputError('claude', 'result has no structured_output or text');
  return parseJson('claude', obj.result, 'claude result text');
}

// Reads at most maxBytes + 1 bytes, so a file that is too large (or still growing) is detected unread.
async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer | null> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let filled = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
    if (filled > maxBytes) return null;
  }
  assert(filled <= maxBytes, 'a bounded read never exceeds its cap');
  return buffer.subarray(0, filled);
}

/** Reads codex's --output-last-message file, refusing one larger than `maxBytes`. */
export async function extractCodexPayload(lastMessageFile: string, maxBytes: number): Promise<unknown> {
  assert(lastMessageFile.length > 0, 'last-message path required');
  assert(Number.isInteger(maxBytes) && maxBytes > 0, 'maxBytes must be a positive integer');
  let handle: FileHandle;
  try {
    handle = await open(lastMessageFile, 'r');
  } catch (cause) {
    throw invalidOutputError('codex', 'codex wrote no final message', cause);
  }
  try {
    if ((await handle.stat()).size > maxBytes) throw failedError('codex', `final message exceeded ${maxBytes} bytes`);
    const bytes = await readBounded(handle, maxBytes);
    if (bytes === null) throw failedError('codex', `final message exceeded ${maxBytes} bytes`);
    return parseJson('codex', bytes.toString('utf8'), 'codex final message');
  } finally {
    await handle.close();
  }
}

export function validatePayload<T>(provider: ProviderId, schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  throw invalidOutputError(provider, 'the response had an unexpected format. Try generating it again.', parsed.error);
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}
