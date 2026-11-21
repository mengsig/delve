import assert from 'node:assert';
import { spawn } from 'node:child_process';
import type { ProviderId } from '../../shared/domain';
import { cancelledError, failedError, notFoundError, timeoutError } from './errors';

export interface CaptureOptions {
  provider: ProviderId;
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
  killGraceMs?: number;
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const DEFAULT_KILL_GRACE_MS = 2_000;

/** Runs a child without a shell; rejects with ProviderError on timeout, cancel, overflow or spawn failure. */
export function runCaptured(opts: CaptureOptions): Promise<CaptureResult> {
  assert(opts.timeoutMs > 0 && opts.maxBytes > 0, 'timeout and output cap must be positive');
  assert(opts.args.every((a) => typeof a === 'string'), 'argv must be strings');
  if (opts.signal.aborted) return Promise.reject(cancelledError(opts.provider));

  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let verdict: Error | null = null;
    let killTimer: NodeJS.Timeout | undefined;

    const stop = (reason: Error): void => {
      if (verdict) return;
      verdict = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    };
    const collect = (sink: Buffer[]) => (chunk: Buffer): void => {
      bytes += chunk.length;
      sink.push(chunk);
      if (bytes > opts.maxBytes) stop(failedError(opts.provider, `output exceeded ${opts.maxBytes} bytes`));
    };
    const onAbort = (): void => stop(cancelledError(opts.provider));
    const timer = setTimeout(() => stop(timeoutError(opts.provider, opts.timeoutMs)), opts.timeoutMs);
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const finish = (): void => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal.removeEventListener('abort', onAbort);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.stdin.on('error', () => undefined); // child may exit before reading stdin; exit status reports it
    child.on('error', (cause: NodeJS.ErrnoException) => {
      finish();
      reject(cause.code === 'ENOENT' ? notFoundError(opts.provider) : failedError(opts.provider, `could not start: ${cause.message}`, cause));
    });
    child.on('close', (code) => {
      finish();
      if (verdict) return reject(verdict);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.end(opts.stdin);
  });
}
