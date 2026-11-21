import assert from 'node:assert';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
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
// After the CLI exits, how long a descendant may keep its inherited pipes open before we stop reading.
const DRAIN_MS = 300;
const TASKKILL_TIMEOUT_MS = 10_000;
const IS_WINDOWS = process.platform === 'win32';

export function windowsSystemTool(relative: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'];
  assert(root !== undefined && path.win32.isAbsolute(root), 'SystemRoot must be an absolute path on Windows');
  return path.win32.join(root, 'System32', relative);
}

/** Sends `signal` to the CLI's process group; a group that no longer exists is already stopped. */
function signalGroup(pid: number, signal: NodeJS.Signals): Error | null {
  assert(Number.isInteger(pid) && pid > 0, 'a process group id is a positive pid');
  try {
    process.kill(-pid, signal);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? null : (error as Error);
  }
}

function taskkillTree(pid: number): Promise<Error | null> {
  assert(Number.isInteger(pid) && pid > 0, 'taskkill needs a positive pid');
  const args = ['/PID', String(pid), '/T', '/F'];
  return new Promise((resolve) => {
    execFile(windowsSystemTool('taskkill.exe'), args, { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true, shell: false }, (error) => {
      resolve(error ? new Error(`taskkill ${pid} failed: ${error.message}`, { cause: error }) : null);
    });
  });
}

/**
 * One CLI execution: bounded output, timeout and cancellation. On timeout or cancel, POSIX sends the
 * CLI's own process group SIGTERM, then SIGKILL after the grace; Windows runs taskkill /T /F.
 * Signals go out only while Node has not reaped the CLI, judged from a timer or setImmediate: libuv
 * reaps a batch of children and reports their exits in one call that never contains those phases, so
 * there `running` means the pid (and POSIX group id) is still held. Inside an exit callback it may not.
 * Limits: descendants that outlive the CLI's exit are not killed (their pipes are dropped after
 * DRAIN_MS), and a descendant that leaves the group or session is out of scope; claude and codex do
 * neither. On Windows the CLI may exit while taskkill starts, so taskkill may name a released pid.
 */
class CapturedRun {
  private readonly out: Buffer[] = [];
  private readonly err: Buffer[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private bytes = 0;
  private verdict: Error | null = null;
  private code: number | null = null;
  private done = false;

  constructor(
    private readonly opts: CaptureOptions,
    private readonly resolve: (result: CaptureResult) => void,
    private readonly reject: (error: Error) => void,
  ) {
    assert(opts.timeoutMs > 0 && opts.maxBytes > 0, 'timeout and output cap must be positive');
    assert(opts.args.every((a) => typeof a === 'string'), 'argv must be strings');
    this.child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true, detached: !IS_WINDOWS, stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  start(): void {
    const { child } = this;
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
    child.on('close', () => this.settle(this.verdict));
    child.stdin.end(this.opts.stdin);
  }

  private readonly onAbort = (): void => this.stop(cancelledError(this.opts.provider));

  private get running(): boolean {
    return this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  private settle(error: Error | null): void {
    if (this.done) return;
    this.done = true;
    this.timers.forEach(clearTimeout);
    this.opts.signal.removeEventListener('abort', this.onAbort);
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (error) return this.reject(error);
    assert(!this.running, 'a successful run has exited');
    const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8');
    this.resolve({ code: this.code, stdout: text(this.out), stderr: text(this.err) });
  }

  private collect(sink: Buffer[], chunk: Buffer): void {
    if (this.verdict || this.done) return;
    if (this.bytes + chunk.length > this.opts.maxBytes) {
      this.out.length = 0;
      this.err.length = 0;
      return this.stop(failedError(this.opts.provider, `output exceeded ${this.opts.maxBytes} bytes`));
    }
    this.bytes += chunk.length;
    sink.push(chunk);
  }

  // Deferred: abort may fire inside another child's exit callback, where `running` can be stale.
  private stop(reason: Error): void {
    if (this.verdict || this.done) return;
    this.verdict = reason;
    setImmediate(() => this.terminate());
  }

  private terminate(): void {
    if (this.done) return;
    assert(this.verdict !== null, 'only a stopped run is terminated');
    if (this.child.pid === undefined) return this.settle(this.verdict);
    if (!this.running) return; // the exit is already reported, and onExit settles with the verdict
    const { provider } = this.opts;
    const pid = this.child.pid;
    if (IS_WINDOWS) {
      void taskkillTree(pid).then((error) => {
        if (error && this.running) this.settle(failedError(provider, 'could not stop the CLI', error));
      });
      return;
    }
    const termError = signalGroup(pid, 'SIGTERM');
    if (termError) return this.settle(failedError(provider, 'could not stop the CLI', termError));
    this.timers.push(setTimeout(() => this.forceKill(pid), this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
  }

  private forceKill(pid: number): void {
    if (!this.running) return;
    const killError = signalGroup(pid, 'SIGKILL');
    if (killError) return this.settle(failedError(this.opts.provider, 'could not kill the CLI', killError));
    // SIGKILL cannot be ignored; this bound only guards against a process stuck in the kernel.
    this.timers.push(setTimeout(() => this.settle(this.verdict), DRAIN_MS));
  }

  // A run settles on exit; a descendant still holding the pipes only delays it by DRAIN_MS.
  private onExit(code: number | null): void {
    assert(this.child.pid !== undefined, 'only a spawned child exits');
    assert(!this.running, 'exit is reported after the child is reaped');
    this.code = code;
    this.timers.push(setTimeout(() => this.settle(this.verdict), DRAIN_MS));
  }
}

/** Runs a child without a shell; rejects with ProviderError on timeout, cancel, overflow or spawn failure. */
export function runCaptured(opts: CaptureOptions): Promise<CaptureResult> {
  if (opts.signal.aborted) return Promise.reject(cancelledError(opts.provider));
  return new Promise((resolve, reject) => new CapturedRun(opts, resolve, reject).start());
}
