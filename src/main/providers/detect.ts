import assert from 'node:assert';
import { execFile } from 'node:child_process';
import type { ProviderId, ProviderStatus } from '../../shared/domain';
import { resolveCommand } from './command';
import { buildChildEnv } from './env';
import { findExecutable } from './which';

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  failure: string | null;
}

type AuthState = Pick<ProviderStatus, 'state' | 'detail'>;

const PROVIDER_ORDER: ProviderId[] = ['claude', 'codex'];
const DEFAULT_TIMEOUT_MS = 10_000;

function runProbe(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr, failure: null });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.killed) return resolve({ code: null, stdout, stderr, failure: 'timed out' });
      if (typeof e.code === 'number') return resolve({ code: e.code, stdout, stderr, failure: null });
      resolve({ code: null, stdout, stderr, failure: e.message });
    });
  });
}

export function parseClaudeAuth(res: ExecResult): AuthState {
  if (res.failure) return { state: 'unknown', detail: `sign-in check failed: ${res.failure}` };
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    assert(typeof parsed === 'object' && parsed !== null, 'auth status must be a JSON object');
    const info = parsed as { loggedIn?: unknown; authMethod?: unknown };
    if (info.loggedIn === true) {
      const method = typeof info.authMethod === 'string' ? info.authMethod : 'unknown method';
      // Only a claude.ai login is a subscription; any other method may bill per use.
      if (method === 'claude.ai') return { state: 'signed-in', detail: 'signed in (claude.ai)' };
      return { state: 'api-key', detail: `signed in with ${method}, not a subscription; Delve will not use it` };
    }
    if (info.loggedIn === false) return { state: 'signed-out', detail: 'not signed in' };
    return { state: 'unknown', detail: 'sign-in check returned no loggedIn field' };
  } catch (cause) {
    return { state: 'unknown', detail: `could not parse sign-in output: ${(cause as Error).message}` };
  }
}

export function parseCodexAuth(res: ExecResult): AuthState {
  if (res.failure) return { state: 'unknown', detail: `sign-in check failed: ${res.failure}` };
  const text = `${res.stdout}\n${res.stderr}`;
  if (/not logged in/i.test(text) || res.code !== 0) return { state: 'signed-out', detail: 'not signed in' };
  if (/logged in using chatgpt/i.test(text)) return { state: 'signed-in', detail: 'signed in (ChatGPT)' };
  if (/api key/i.test(text)) return { state: 'api-key', detail: 'signed in with an API key, not a subscription; Delve will not use it' };
  return { state: 'unknown', detail: 'unrecognised sign-in output' };
}

const PROBES: Record<ProviderId, { authArgs: string[]; parse: (r: ExecResult) => AuthState }> = {
  claude: { authArgs: ['auth', 'status'], parse: parseClaudeAuth },
  codex: { authArgs: ['login', 'status'], parse: parseCodexAuth },
};

async function detectOne(id: ProviderId, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProviderStatus> {
  const binPath = await findExecutable(id, env);
  if (binPath === null) return { id, state: 'not-found', path: null, version: null, detail: 'not found on PATH' };
  const resolution = await resolveCommand(binPath, env);
  if (!resolution.ok) return { id, state: 'unknown', path: binPath, version: null, detail: resolution.problem };
  const { file, prefixArgs } = resolution.command;
  const probe = PROBES[id];
  const [versionRes, authRes] = await Promise.all([
    runProbe(file, [...prefixArgs, '--version'], env, timeoutMs),
    runProbe(file, [...prefixArgs, ...probe.authArgs], env, timeoutMs),
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
  const statuses = await Promise.all(PROVIDER_ORDER.map((id) => detectOne(id, env, timeoutMs)));
  assert(statuses.length === PROVIDER_ORDER.length, 'one status per provider');
  return statuses;
}
