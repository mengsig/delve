import assert from 'node:assert';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
// After the CLI exits, how long its pipes may stay open (held by descendants) before we stop waiting.
const DRAIN_MS = 500;
const IS_WINDOWS = process.platform === 'win32';

/**
 * Signals the CLI and every descendant. On POSIX the child leads its own process group;
 * on Windows taskkill /T walks the tree. Resolves to an error only when the tree could not be signalled.
 */
export function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): Promise<Error | null> {
  assert(child.pid !== undefined, 'only a spawned child can be killed');
  const pid = child.pid;
  if (IS_WINDOWS) {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) =>
        resolve(error && child.exitCode === null ? error : null),
      );
    });
  }
  try {
    process.kill(-pid, signal);
    return Promise.resolve(null);
  } catch (error) {
    // ESRCH: the whole group already exited, which is the outcome we want.
    return Promise.resolve((error as NodeJS.ErrnoException).code === 'ESRCH' ? null : (error as Error));
  }
}

function startChild(opts: CaptureOptions): ChildProcessWithoutNullStreams {
  assert(opts.timeoutMs > 0 && opts.maxBytes > 0, 'timeout and output cap must be positive');
  assert(opts.args.every((a) => typeof a === 'string'), 'argv must be strings');
  return spawn(opts.bin, opts.args, {
    cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true, detached: !IS_WINDOWS, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Runs a child without a shell; rejects with ProviderError on timeout, cancel, overflow or spawn failure. */
export function runCaptured(opts: CaptureOptions): Promise<CaptureResult> {
  if (opts.signal.aborted) return Promise.reject(cancelledError(opts.provider));
  const grace = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  return new Promise((resolve, reject) => {
    const child = startChild(opts);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let verdict: Error | null = null;
    let done = false;
    const timers: NodeJS.Timeout[] = [];

    const settle = (error: Error | null, code: number | null = null): void => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      opts.signal.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) return reject(error);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    const stop = (reason: Error): void => {
      if (verdict) return;
      verdict = reason;
      void killTree(child, 'SIGTERM').then((e) => e && settle(failedError(opts.provider, 'could not stop the CLI', e)));
      const forceKill = (): void => void killTree(child, 'SIGKILL').then((e) => e && settle(failedError(opts.provider, 'could not kill the CLI', e)));
      timers.push(setTimeout(forceKill, grace));
      timers.push(setTimeout(() => settle(reason), grace + DRAIN_MS));
    };
    const collect = (sink: Buffer[]) => (chunk: Buffer): void => {
      if (verdict) return;
      if (bytes + chunk.length > opts.maxBytes) return stop(failedError(opts.provider, `output exceeded ${opts.maxBytes} bytes`));
      bytes += chunk.length;
      sink.push(chunk);
    };
    const onAbort = (): void => stop(cancelledError(opts.provider));
    timers.push(setTimeout(() => stop(timeoutError(opts.provider, opts.timeoutMs)), opts.timeoutMs));
    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.stdin.on('error', () => undefined); // child may exit before reading stdin; exit status reports it
    child.on('error', (cause: NodeJS.ErrnoException) => {
      settle(cause.code === 'ENOENT' ? notFoundError(opts.provider) : failedError(opts.provider, `could not start: ${cause.message}`, cause));
    });
    child.on('exit', (code) => {
      // Reap descendants that outlived the CLI, then stop waiting for pipes they may hold.
      void killTree(child, 'SIGKILL').then((e) => e && settle(failedError(opts.provider, 'could not stop leftover processes', e)));
      timers.push(setTimeout(() => settle(verdict, code), DRAIN_MS));
    });
    child.on('close', (code) => settle(verdict, code));
    child.stdin.end(opts.stdin);
  });
}
