import assert from 'node:assert';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ProviderId } from '../../shared/domain';
import { cancelledError, failedError, notFoundError, timeoutError } from './errors';
import { MARKER_VAR, readProcessTable, selectTargets, windowsSystemTool } from './proctable';

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

/** A spawned CLI and what identifies its descendants: the run marker and the spawn time. */
export interface RunTree {
  child: ChildProcessWithoutNullStreams;
  marker: string;
  startedMs: number;
}

const DEFAULT_KILL_GRACE_MS = 2_000;
// After the CLI exits and leftovers are reaped, how long its pipes may stay open before we stop waiting.
const DRAIN_MS = 500;
// Tolerates clock granularity between Date.now() and Windows process creation times.
const CREATION_SLACK_MS = 1_000;
const TASKKILL_NOT_FOUND = 128;
const IS_WINDOWS = process.platform === 'win32';

function signalPosix(pid: number, signal: NodeJS.Signals): Error | null {
  try {
    process.kill(pid, signal);
    return null;
  } catch (error) {
    // ESRCH: the process already exited, which is the outcome we want.
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? null : (error as Error);
  }
}

function taskkill(pid: number): Promise<Error | null> {
  return new Promise((resolve) => {
    execFile(windowsSystemTool('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false }, (error) => {
      if (!error) return resolve(null);
      const exitCode: unknown = (error as { code?: unknown }).code;
      resolve(exitCode === TASKKILL_NOT_FOUND ? null : error);
    });
  });
}

/**
 * Stops the CLI and every process it started: its POSIX process group, its descendants by parent link,
 * and anything carrying the run marker (helpers that setsid or were reparented). Returns the first failure.
 * Limit: a helper that both clears its environment and detaches before the scan cannot be traced.
 */
export async function reapTree(tree: RunTree, signal: NodeJS.Signals): Promise<Error | null> {
  const pid = tree.child.pid;
  assert(pid !== undefined && pid > 0, 'only a spawned child can be reaped');
  let targets: number[];
  try {
    targets = selectTargets(await readProcessTable(tree.marker), pid, tree.startedMs - CREATION_SLACK_MS);
  } catch (error) {
    // Still stop what we can reach, and report that the scan failed.
    const rootError = IS_WINDOWS ? await taskkill(pid) : signalPosix(-pid, signal);
    return rootError ?? (error as Error);
  }
  if (IS_WINDOWS) {
    const errors = await Promise.all([pid, ...targets].map(taskkill));
    return errors.find((e) => e !== null) ?? null;
  }
  const errors = [signalPosix(-pid, signal), ...targets.map((target) => signalPosix(target, signal))];
  return errors.find((e) => e !== null) ?? null;
}

function startChild(opts: CaptureOptions, marker: string): ChildProcessWithoutNullStreams {
  assert(opts.timeoutMs > 0 && opts.maxBytes > 0, 'timeout and output cap must be positive');
  assert(opts.args.every((a) => typeof a === 'string'), 'argv must be strings');
  return spawn(opts.bin, opts.args, {
    cwd: opts.cwd, env: { ...opts.env, [MARKER_VAR]: marker }, shell: false, windowsHide: true,
    detached: !IS_WINDOWS, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** One CLI execution: collects bounded output, enforces timeout and cancellation, reaps the tree on exit. */
class CapturedRun {
  private readonly out: Buffer[] = [];
  private readonly err: Buffer[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly tree: RunTree;
  private bytes = 0;
  private verdict: Error | null = null;
  private code: number | null = null;
  private done = false;
  private closed = false;
  private reaped = false;

  constructor(
    private readonly opts: CaptureOptions,
    private readonly resolve: (result: CaptureResult) => void,
    private readonly reject: (error: Error) => void,
  ) {
    const marker = randomUUID();
    const startedMs = Date.now();
    this.tree = { child: startChild(opts, marker), marker, startedMs };
  }

  start(): void {
    const { child } = this.tree;
    const { provider, timeoutMs, signal } = this.opts;
    this.timers.push(setTimeout(() => this.stop(timeoutError(provider, timeoutMs)), timeoutMs));
    signal.addEventListener('abort', this.onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => this.collect(this.out, chunk));
    child.stderr.on('data', (chunk: Buffer) => this.collect(this.err, chunk));
    child.stdin.on('error', () => undefined); // child may exit before reading stdin; exit status reports it
    child.on('error', (cause: NodeJS.ErrnoException) => {
      this.settle(cause.code === 'ENOENT' ? notFoundError(provider) : failedError(provider, `could not start: ${cause.message}`, cause));
    });
    child.on('exit', (code) => this.onExit(code));
    child.on('close', () => {
      this.closed = true;
      if (this.reaped) this.settle(this.verdict);
    });
    child.stdin.end(this.opts.stdin);
  }

  private readonly onAbort = (): void => this.stop(cancelledError(this.opts.provider));

  private settle(error: Error | null): void {
    if (this.done) return;
    this.done = true;
    this.timers.forEach(clearTimeout);
    this.opts.signal.removeEventListener('abort', this.onAbort);
    this.tree.child.stdout.destroy();
    this.tree.child.stderr.destroy();
    if (error) return this.reject(error);
    const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8');
    this.resolve({ code: this.code, stdout: text(this.out), stderr: text(this.err) });
  }

  private collect(sink: Buffer[], chunk: Buffer): void {
    if (this.verdict || this.done) return;
    if (this.bytes + chunk.length > this.opts.maxBytes) {
      return this.stop(failedError(this.opts.provider, `output exceeded ${this.opts.maxBytes} bytes`));
    }
    this.bytes += chunk.length;
    sink.push(chunk);
  }

  private stop(reason: Error): void {
    if (this.verdict || this.done) return;
    this.verdict = reason;
    if (this.tree.child.pid === undefined) return this.settle(reason);
    const { provider } = this.opts;
    void reapTree(this.tree, 'SIGTERM').then((e) => e && this.settle(failedError(provider, 'could not stop the CLI', e)));
    const forceKill = (): void => {
      void reapTree(this.tree, 'SIGKILL').then((e) => this.settle(e ? failedError(provider, 'could not kill the CLI', e) : reason));
    };
    this.timers.push(setTimeout(forceKill, this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
  }

  // Reap descendants that outlived the CLI, then wait briefly for pipes they may still hold.
  private onExit(code: number | null): void {
    this.code = code;
    void reapTree(this.tree, 'SIGKILL').then((error) => {
      if (this.done) return;
      if (error) return this.settle(failedError(this.opts.provider, 'could not stop leftover processes', error));
      this.reaped = true;
      if (this.closed) return this.settle(this.verdict);
      this.timers.push(setTimeout(() => this.settle(this.verdict), DRAIN_MS));
    });
  }
}

/** Runs a child without a shell; rejects with ProviderError on timeout, cancel, overflow or spawn failure. */
export function runCaptured(opts: CaptureOptions): Promise<CaptureResult> {
  if (opts.signal.aborted) return Promise.reject(cancelledError(opts.provider));
  return new Promise((resolve, reject) => new CapturedRun(opts, resolve, reject).start());
}
