import assert from 'node:assert';
import type { ProviderId, ProviderStatus } from '../../shared/domain';
import { resolveCommand } from './command';
import { buildChildEnv } from './env';
import { ProviderError } from './errors';
import { runCaptured } from './process';
import { findExecutable } from './which';

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  failure: string | null;
}

type AuthState = Pick<ProviderStatus, 'state' | 'detail'>;

const PROVIDER_ORDER: ProviderId[] = ['claude', 'codex'];
const DEFAULT_TIMEOUT_MS = 10_000;

async function runProbe(provider: ProviderId, bin: string, args: string[], env: NodeJS.ProcessEnv,
  timeoutMs: number, signal: AbortSignal): Promise<ExecResult> {
  try {
    const result = await runCaptured({ provider, bin, args, env, timeoutMs, signal, cwd: process.cwd(),
      stdin: '', maxBytes: 1024 * 1024 });
    return { ...result, failure: result.code === null ? 'process terminated by a signal' : null };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return { code: null, stdout: '', stderr: '', failure: error.code === 'PROVIDER_TIMEOUT' ? 'timed out' : error.message };
  }
}

const NO_SUBSCRIPTION = 'not signed in with a subscription';

interface ClaudeAuthInfo {
  loggedIn?: unknown;
  authMethod?: unknown;
  apiProvider?: unknown;
  apiKeySource?: unknown;
  subscriptionType?: unknown;
}

/**
 * Classifies `claude auth status` JSON. A subscription is a claude.ai login (or a subscription OAuth
 * token) on Anthropic's own API with no API key configured, stored or helper-provided.
 */
function classifyClaudeLogin(info: ClaudeAuthInfo): AuthState {
  const method = typeof info.authMethod === 'string' ? info.authMethod : 'an unknown method';
  if (info.apiProvider !== undefined && info.apiProvider !== 'firstParty') {
    return { state: 'api-key', detail: `${NO_SUBSCRIPTION}: requests go through ${String(info.apiProvider)}` };
  }
  if (typeof info.apiKeySource === 'string') {
    return { state: 'api-key', detail: `${NO_SUBSCRIPTION}: an API key is configured (${info.apiKeySource})` };
  }
  const hasPlan = typeof info.subscriptionType === 'string' && info.subscriptionType.length > 0;
  if (method === 'claude.ai' || (method === 'oauth_token' && hasPlan)) return { state: 'signed-in', detail: `signed in (${method})` };
  if (method === 'api_key' || method === 'api_key_helper') return { state: 'api-key', detail: `${NO_SUBSCRIPTION}: signed in with ${method}` };
  return { state: 'unknown', detail: `could not confirm a subscription login (signed in with ${method})` };
}

export function parseClaudeAuth(res: ExecResult): AuthState {
  if (res.failure) return { state: 'unknown', detail: `sign-in check failed: ${res.failure}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    return { state: 'unknown', detail: 'The sign-in response was unreadable. Check your login in a terminal and try again.' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { state: 'unknown', detail: 'sign-in output is not a JSON object' };
  const info = parsed as ClaudeAuthInfo;
  if (info.loggedIn === false) return { state: 'signed-out', detail: 'not signed in' };
  if (info.loggedIn !== true) return { state: 'unknown', detail: 'sign-in check returned no loggedIn field' };
  return classifyClaudeLogin(info);
}

/** Classifies `codex login status`, which reports a stored API key as "Logged in using an API key". */
export function parseCodexAuth(res: ExecResult): AuthState {
  if (res.failure) return { state: 'unknown', detail: `sign-in check failed: ${res.failure}` };
  const text = `${res.stdout}\n${res.stderr}`;
  if (/not logged in/i.test(text)) return { state: 'signed-out', detail: 'not signed in' };
  if (/api key/i.test(text)) return { state: 'api-key', detail: `${NO_SUBSCRIPTION}: signed in with an API key` };
  if (res.code !== 0) return { state: 'signed-out', detail: 'not signed in' };
  if (/logged in using chatgpt/i.test(text)) return { state: 'signed-in', detail: 'signed in (ChatGPT)' };
  return { state: 'unknown', detail: 'unrecognised sign-in output' };
}

const PROBES: Record<ProviderId, { authArgs: string[]; parse: (r: ExecResult) => AuthState }> = {
  claude: { authArgs: ['auth', 'status'], parse: parseClaudeAuth },
  codex: { authArgs: ['login', 'status'], parse: parseCodexAuth },
};

async function detectOne(id: ProviderId, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal): Promise<ProviderStatus> {
  const binPath = await findExecutable(id, env);
  if (binPath === null) return { id, state: 'not-found', path: null, version: null, detail: 'not found on PATH' };
  const resolution = await resolveCommand(binPath, env);
  if (!resolution.ok) return { id, state: 'unknown', path: binPath, version: null, detail: resolution.problem };
  const { file, prefixArgs } = resolution.command;
  const probe = PROBES[id];
  const [versionRes, authRes] = await Promise.all([
    runProbe(id, file, [...prefixArgs, '--version'], env, timeoutMs, signal),
    runProbe(id, file, [...prefixArgs, ...probe.authArgs], env, timeoutMs, signal),
  ]);
  const version = versionRes.failure === null && versionRes.code === 0 ? versionRes.stdout.trim().split('\n')[0] ?? null : null;
  const auth = probe.parse(authRes);
  assert(auth.detail.length > 0, 'status detail must explain the state');
  return { id, path: binPath, version: version || null, ...auth };
}

export async function detectProviders(options: DetectOptions = {}): Promise<ProviderStatus[]> {
  const env = buildChildEnv(options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assert(timeoutMs > 0, 'timeoutMs must be positive');
  const signal = options.signal ?? new AbortController().signal;
  const statuses = await Promise.all(PROVIDER_ORDER.map((id) => detectOne(id, env, timeoutMs, signal)));
  assert(statuses.length === PROVIDER_ORDER.length, 'one status per provider');
  return statuses;
}
