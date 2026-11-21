import assert from 'node:assert';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { z } from 'zod';
import { PROVIDER_IDS, type ProviderId, type ProviderStatus } from '../../shared/domain';
import { buildClaudeArgv, buildCodexArgv, validateModel } from './argv';
import { apiKeyAuthError, authError, cancelledError, failedError, notFoundError, unknownAuthError } from './errors';
import { buildChildEnv } from './env';
import { checkExit, extractClaudePayload, extractCodexPayload, isProviderError, validatePayload } from './output';
import { runCaptured } from './process';
import { resolveCommand, type Command } from './command';

export interface RunnerDeps {
  /** Current status of a provider; the runner only proceeds for a subscription sign-in. */
  resolveProvider: (id: ProviderId) => Promise<ProviderStatus>;
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
  /** Cancels this caller only; the shared run stops when its last caller cancels. */
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
// setTimeout cannot wait longer than 2^31 - 1 ms; an hour is far beyond any real run.
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

interface Attempt {
  command: Command;
  root: string;
  workDir: string;
  ioDir: string;
}

interface InFlight {
  promise: Promise<RunResult<unknown>>;
  controller: AbortController;
  subscribers: number;
}

/** Returns the executable path, or throws why this provider must not run. */
export function requireSubscription(status: ProviderStatus): string {
  assert(PROVIDER_IDS.includes(status.id), `unknown provider ${status.id}`);
  switch (status.state) {
    case 'not-found':
      throw notFoundError(status.id);
    case 'signed-out':
      throw authError(status.id);
    case 'api-key':
      throw apiKeyAuthError(status.id);
    case 'unknown':
      throw unknownAuthError(status.id, status.detail);
    case 'signed-in':
      assert(status.path !== null && status.path.length > 0, 'a signed-in provider has an executable path');
      return status.path;
  }
}

/**
 * Runs provider CLIs, sharing one process among concurrent callers with the same cache key. Each
 * caller cancels only its own wait; the process is stopped once every caller has cancelled.
 */
export class ProviderRunner {
  private readonly inFlight = new Map<string, InFlight>();

  constructor(private readonly deps: RunnerDeps) {}

  run<T>(req: RunRequest<T>): Promise<RunResult<T>> {
    assert(req.cacheKey.length > 0, 'cacheKey required');
    assert(req.prompt.length > 0, 'prompt required');
    const retries = req.maxRetries;
    assert(retries === undefined || (Number.isInteger(retries) && retries >= 0 && retries <= MAX_RETRIES), `maxRetries must be an integer from 0 to ${MAX_RETRIES}`);
    const timeout = req.timeoutMs;
    assert(timeout === undefined || (Number.isInteger(timeout) && timeout > 0 && timeout <= MAX_TIMEOUT_MS), `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
    const entry = this.inFlight.get(req.cacheKey) ?? this.start(req);
    return this.subscribe(entry, req);
  }

  private start<T>(req: RunRequest<T>): InFlight {
    const controller = new AbortController();
    const promise: Promise<RunResult<unknown>> = this.runWithRetries(req, controller.signal).finally(() => {
      if (this.inFlight.get(req.cacheKey)?.promise === promise) this.inFlight.delete(req.cacheKey);
    });
    const entry: InFlight = { controller, subscribers: 0, promise };
    this.inFlight.set(req.cacheKey, entry);
    assert(this.inFlight.get(req.cacheKey) === entry, 'new run must be registered');
    return entry;
  }

  // Each caller gets its own promise so its signal cancels only its own wait.
  private subscribe<T>(entry: InFlight, req: RunRequest<T>): Promise<RunResult<T>> {
    entry.subscribers += 1;
    return new Promise<RunResult<T>>((resolve, reject) => {
      let left = false;
      const leave = (): boolean => {
        if (left) return false;
        left = true;
        req.signal?.removeEventListener('abort', onAbort);
        entry.subscribers -= 1;
        assert(entry.subscribers >= 0, 'subscriber count cannot go negative');
        return true;
      };
      const onAbort = (): void => {
        if (!leave()) return;
        if (entry.subscribers === 0) this.abandon(req.cacheKey, entry);
        reject(cancelledError(req.provider));
      };
      entry.promise.then(
        (value) => {
          if (leave()) resolve(value as RunResult<T>);
        },
        (error: unknown) => {
          if (leave()) reject(error);
        },
      );
      if (req.signal?.aborted) onAbort();
      else req.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private abandon(cacheKey: string, entry: InFlight): void {
    if (this.inFlight.get(cacheKey) === entry) this.inFlight.delete(cacheKey);
    entry.controller.abort();
  }

  private async runWithRetries<T>(req: RunRequest<T>, signal: AbortSignal): Promise<RunResult<T>> {
    const retries = req.maxRetries ?? DEFAULT_RETRIES;
    const model = req.model === undefined ? null : validateModel(req.model);
    const bin = requireSubscription(await this.deps.resolveProvider(req.provider));
    const resolution = await resolveCommand(bin, this.deps.env ?? process.env);
    if (!resolution.ok) throw failedError(req.provider, resolution.problem);
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw cancelledError(req.provider);
      try {
        const value = await this.runOnce(req, resolution.command, signal);
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

  private async runOnce<T>(req: RunRequest<T>, command: Command, signal: AbortSignal): Promise<T> {
    const tempRoot = await realpath(this.deps.tempRoot ?? tmpdir());
    const root = await mkdtemp(path.join(tempRoot, 'delve-run-'));
    const attempt: Attempt = { command, root, workDir: path.join(root, 'work'), ioDir: path.join(root, 'io') };
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
      provider: req.provider, bin: a.command.file, args: [...a.command.prefixArgs, ...args], cwd: a.workDir,
      env: buildChildEnv(this.deps.env ?? process.env), stdin: req.prompt,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: MAX_OUTPUT_BYTES,
      signal, killGraceMs: this.deps.killGraceMs,
    });
    checkExit(req.provider, res);
    const payload = isCodex ? await extractCodexPayload(lastMessageFile, MAX_OUTPUT_BYTES) : extractClaudePayload(res);
    return validatePayload(req.provider, req.schema, payload);
  }
}
