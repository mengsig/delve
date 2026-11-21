import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
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

function tail(text: string): string {
  return text.trim().slice(-300) || 'no output';
}

/** Throws auth/quota/failed errors for a finished child; returns when the exit looks successful. */
export function checkExit(provider: ProviderId, res: CaptureResult): void {
  assert(res.code === null || Number.isInteger(res.code), 'exit code must be an integer or null');
  const text = `${res.stderr}\n${res.stdout}`;
  const classified = classifyText(provider, text);
  if (classified && res.code !== 0) throw classified;
  if (res.code !== 0) throw failedError(provider, `exited with code ${res.code}: ${tail(res.stderr || res.stdout)}`);
}

/** Extracts the structured payload from claude's single JSON result object. */
export function extractClaudePayload(res: CaptureResult): unknown {
  const envelope = parseJson('claude', res.stdout, 'claude output');
  if (typeof envelope !== 'object' || envelope === null) throw invalidOutputError('claude', 'result is not an object');
  const obj = envelope as { is_error?: unknown; result?: unknown; structured_output?: unknown };
  if (obj.is_error === true) {
    const text = typeof obj.result === 'string' ? obj.result : '';
    throw classifyText('claude', text) ?? failedError('claude', tail(text));
  }
  if (obj.structured_output !== undefined && obj.structured_output !== null) return obj.structured_output;
  if (typeof obj.result !== 'string') throw invalidOutputError('claude', 'result has no structured_output or text');
  return parseJson('claude', obj.result, 'claude result text');
}

export async function extractCodexPayload(lastMessageFile: string): Promise<unknown> {
  assert(lastMessageFile.length > 0, 'last-message path required');
  let text: string;
  try {
    text = await readFile(lastMessageFile, 'utf8');
  } catch (cause) {
    throw invalidOutputError('codex', 'codex wrote no final message', cause);
  }
  return parseJson('codex', text, 'codex final message');
}

export function validatePayload<T>(provider: ProviderId, schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  throw invalidOutputError(provider, issues, parsed.error);
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}
