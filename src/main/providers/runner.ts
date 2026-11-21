import assert from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { z } from 'zod';
import type { ProviderId } from '../../shared/domain';
import { buildClaudeArgv, buildCodexArgv, validateModel } from './argv';
import { cancelledError, failedError, notFoundError } from './errors';
import { checkExit, extractClaudePayload, extractCodexPayload, isProviderError, validatePayload } from './output';
import { runCaptured } from './process';

export interface RunnerDeps {
  resolveExecutable: (id: ProviderId) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  killGraceMs?: number;
  retryBackoffMs?: number;
}

export interface RunRequest<T> {
  provider: ProviderId;
  prompt: string;
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  cacheKey: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface RunResult<T> {
  value: T;
  provider: ProviderId;
  model: string | null;
  attempts: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_RETRIES = 1;
const MAX_RETRIES = 3;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];

export function buildChildEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const key of STRIPPED_ENV) delete env[key];
  assert(STRIPPED_ENV.every((k) => !(k in env)), 'API keys must never reach the child');
  return env;
}

interface Attempt {
  bin: string;
  root: string;
  workDir: string;
  ioDir: string;
}

export class ProviderRunner {
  private readonly inFlight = new Map<string, { promise: Promise<unknown>; controller: AbortController }>();

  constructor(private readonly deps: RunnerDeps) {}

  run<T>(req: RunRequest<T>): Promise<RunResult<T>> {
    assert(req.cacheKey.length > 0, 'cacheKey required');
    assert(req.prompt.length > 0, 'prompt required');
    const existing = this.inFlight.get(req.cacheKey);
    if (existing) return existing.promise as Promise<RunResult<T>>;

    const controller = new AbortController();
    const forward = (): void => controller.abort();
    req.signal?.addEventListener('abort', forward, { once: true });
    if (req.signal?.aborted) controller.abort();

    const promise = this.runWithRetries(req, controller.signal).finally(() => {
      req.signal?.removeEventListener('abort', forward);
      this.inFlight.delete(req.cacheKey);
    });
    this.inFlight.set(req.cacheKey, { promise, controller });
    return promise;
  }

  cancel(cacheKey: string): boolean {
    const entry = this.inFlight.get(cacheKey);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  private async runWithRetries<T>(req: RunRequest<T>, signal: AbortSignal): Promise<RunResult<T>> {
    const retries = Math.min(Math.max(req.maxRetries ?? DEFAULT_RETRIES, 0), MAX_RETRIES);
    const model = req.model === undefined ? null : validateModel(req.model);
    for (let attempt = 1; ; attempt++) {
      try {
        const value = await this.runOnce(req, signal);
        return { value, provider: req.provider, model, attempts: attempt };
      } catch (e) {
        if (!isProviderError(e) || !e.retryable || attempt > retries) throw e;
        await this.backoff(req.provider, attempt, signal);
      }
    }
  }

  private backoff(provider: ProviderId, attempt: number, signal: AbortSignal): Promise<void> {
    const ms = (this.deps.retryBackoffMs ?? 500) * attempt;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(cancelledError(provider));
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(cancelledError(provider));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async runOnce<T>(req: RunRequest<T>, signal: AbortSignal): Promise<T> {
    const bin = await this.deps.resolveExecutable(req.provider);
    if (bin === null) throw notFoundError(req.provider);
    const root = await mkdtemp(path.join(this.deps.tempRoot ?? tmpdir(), 'delve-run-'));
    const attempt: Attempt = { bin, root, workDir: path.join(root, 'work'), ioDir: path.join(root, 'io') };
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await this.execute(req, attempt, signal) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    await this.removeRoot(req.provider, root, outcome.ok ? undefined : outcome.error);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  // A cleanup failure is raised, carrying the attempt's own error so neither is lost.
  private async removeRoot(provider: ProviderId, root: string, primary: unknown): Promise<void> {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (cause) {
      const combined = primary === undefined ? cause : new AggregateError([primary, cause], 'run and cleanup both failed');
      throw failedError(provider, `could not remove temporary directory ${root}`, combined);
    }
  }

  private async execute<T>(req: RunRequest<T>, a: Attempt, signal: AbortSignal): Promise<T> {
    await mkdir(a.workDir);
    await mkdir(a.ioDir);
    const schemaFile = path.join(a.ioDir, 'schema.json');
    const lastMessageFile = path.join(a.ioDir, 'last-message.json');
    const isCodex = req.provider === 'codex';
    if (isCodex) await writeFile(schemaFile, JSON.stringify(req.jsonSchema));
    const args = isCodex
      ? buildCodexArgv({ workDir: a.workDir, schemaFile, lastMessageFile }, req.model)
      : buildClaudeArgv(req.jsonSchema, req.model);

    const res = await runCaptured({
      provider: req.provider, bin: a.bin, args, cwd: a.workDir,
      env: buildChildEnv(this.deps.env ?? process.env), stdin: req.prompt,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: MAX_OUTPUT_BYTES,
      signal, killGraceMs: this.deps.killGraceMs,
    });
    checkExit(req.provider, res);
    const payload = isCodex ? await extractCodexPayload(lastMessageFile) : extractClaudePayload(res);
    return validatePayload(req.provider, req.schema, payload);
  }
}
