import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Every process a run starts inherits this variable, so it can be found after leaving the process group. */
export const MARKER_VAR = 'DELVE_RUN_MARKER';

export interface ProcessEntry {
  pid: number;
  ppid: number;
  marked: boolean;
  startedMs: number | null;
}

const QUERY_TIMEOUT_MS = 10_000;
const QUERY_MAX_BUFFER = 16 * 1024 * 1024;
// /proc entries vanish while scanning, and other users' environ files are private.
const UNREADABLE = new Set(['ENOENT', 'ESRCH', 'EACCES', 'EPERM']);

function toPid(text: string, what: string): number {
  const value = Number(text);
  assert(Number.isInteger(value) && value >= 0, `${what} must be a non-negative integer, got "${text}"`);
  return value;
}

/** Parent pid from /proc/<pid>/stat; the command name may itself contain spaces and parentheses. */
export function parseProcStatPpid(stat: string): number {
  const end = stat.lastIndexOf(')');
  assert(end > 0, 'stat must contain a parenthesised command name');
  const fields = stat.slice(end + 2).split(' ');
  assert(fields.length > 2, 'stat must list state and parent pid');
  return toPid(fields[1] ?? '', 'stat ppid');
}

export function environHasMarker(environ: string, marker: string): boolean {
  assert(marker.length > 0 && !marker.includes('\0'), 'marker must be a non-empty single token');
  return environ.split('\0').includes(`${MARKER_VAR}=${marker}`);
}

/** Parses `ps -E -ww -A -o pid=,ppid=,command=`, which appends each process's environment to its command. */
export function parsePsTable(text: string, marker: string): ProcessEntry[] {
  assert(marker.length > 0, 'marker must be non-empty');
  const needle = ` ${MARKER_VAR}=${marker} `;
  const entries: ProcessEntry[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (!match) continue;
    const pid = toPid(match[1] ?? '', 'ps pid');
    entries.push({ pid, ppid: toPid(match[2] ?? '', 'ps ppid'), marked: ` ${match[3] ?? ''} `.includes(needle), startedMs: null });
  }
  return entries;
}

/** Parses lines of "<pid> <ppid> <creation ms since epoch>" printed by WINDOWS_QUERY. */
export function parseWindowsTable(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    assert(match, `unexpected process table line: "${line}"`);
    const startedMs = Number(match[3]);
    entries.push({ pid: toPid(match[1] ?? '', 'pid'), ppid: toPid(match[2] ?? '', 'ppid'), marked: false, startedMs: startedMs > 0 ? startedMs : null });
  }
  return entries;
}

/** Where a walk starts: the CLI, with its spawn and exit times (Windows) or null times (POSIX). */
export interface WalkOrigin {
  pid: number;
  startedMs: number | null;
  exitedMs: number | null;
}

/**
 * Whether `child` was created by the process that held `parent.pid`. POSIX parent links are current,
 * so only a live parent counts; Windows keeps stale links, so creation must fall in the parent's lifetime.
 */
function bornUnder(child: ProcessEntry, parent: WalkOrigin): boolean {
  if (parent.startedMs === null) return parent.exitedMs === null;
  if (child.startedMs === null || child.startedMs < parent.startedMs) return false;
  return parent.exitedMs === null || child.startedMs <= parent.exitedMs;
}

/**
 * Processes to stop besides the CLI itself: every one carrying the run marker, and the descendants of
 * the CLI and of marked processes through parent links that cannot belong to a reused pid.
 */
export function selectTargets(entries: ProcessEntry[], origin: WalkOrigin): ProcessEntry[] {
  assert(Number.isInteger(origin.pid) && origin.pid > 0, 'root pid must be a positive integer');
  assert(origin.exitedMs === null || origin.startedMs === null || origin.exitedMs >= origin.startedMs, 'exit follows start');
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of entries) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
  const selected = new Map(entries.filter((e) => e.marked && e.pid !== origin.pid).map((e) => [e.pid, e]));
  const queue: WalkOrigin[] = [origin, ...[...selected.values()].map((e) => ({ pid: e.pid, startedMs: e.startedMs, exitedMs: null }))];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const parent = queue.pop() as WalkOrigin;
    if (visited.has(parent.pid)) continue;
    visited.add(parent.pid);
    for (const child of children.get(parent.pid) ?? []) {
      if (child.pid === origin.pid || !bornUnder(child, parent)) continue;
      selected.set(child.pid, child);
      queue.push({ pid: child.pid, startedMs: child.startedMs, exitedMs: null });
    }
  }
  selected.delete(process.pid);
  assert(![...selected.keys()].some((pid) => pid <= 0), 'never target pid 0 or process groups');
  return [...selected.values()].sort((a, b) => a.pid - b.pid);
}

/**
 * PowerShell that kills each target only through a handle whose start time matches the scan, so a pid
 * reused since the scan is never touched. Exits 1 listing the targets it could not stop.
 */
export function windowsKillScript(targets: ProcessEntry[]): string {
  assert(targets.length > 0, 'nothing to kill');
  const pairs = targets.map((t) => {
    assert(Number.isInteger(t.pid) && t.pid > 0, `invalid pid ${t.pid}`);
    assert(t.startedMs !== null && Number.isInteger(t.startedMs) && t.startedMs > 0, `pid ${t.pid} needs a creation time`);
    return `'${t.pid}:${t.startedMs}'`;
  });
  return [
    `$failed = @(); foreach ($s in @(${pairs.join(',')})) { $t = $s.Split(':'); $id = [int]$t[0]; $ms = [long]$t[1]`,
    '$p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($null -eq $p) { continue }',
    'if (([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() -ne $ms) { continue }',
    'try { $p.Kill() } catch { $p.Refresh(); if (-not $p.HasExited) { $failed += "${id}: $($_.Exception.Message)" } } }',
    'if ($failed.Count -gt 0) { [Console]::Error.WriteLine($failed -join "; "); exit 1 }',
  ].join('\n');
}

async function readProcFile(pid: number, name: string): Promise<string | null> {
  try {
    return await readFile(`/proc/${pid}/${name}`, 'utf8');
  } catch (error) {
    if (UNREADABLE.has((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}

async function readLinuxEntry(pid: number, marker: string): Promise<ProcessEntry | null> {
  const stat = await readProcFile(pid, 'stat');
  if (stat === null) return null;
  const environ = await readProcFile(pid, 'environ');
  return { pid, ppid: parseProcStatPpid(stat), marked: environ !== null && environHasMarker(environ, marker), startedMs: null };
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: QUERY_TIMEOUT_MS, maxBuffer: QUERY_MAX_BUFFER, windowsHide: true, shell: false }, (error, stdout) => {
      if (error) return reject(new Error(`process table query ${path.basename(file)} failed: ${error.message}`, { cause: error }));
      resolve(stdout);
    });
  });
}

export function windowsSystemTool(relative: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'];
  assert(root !== undefined && path.win32.isAbsolute(root), 'SystemRoot must be an absolute path on Windows');
  return path.win32.join(root, 'System32', relative);
}

const WINDOWS_QUERY =
  'Get-CimInstance Win32_Process | ForEach-Object { $t = 0; if ($_.CreationDate) { $t = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; "$($_.ProcessId) $($_.ParentProcessId) $t" }';

function windowsPowerShell(command: string): Promise<string> {
  return execText(windowsSystemTool('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command]);
}

/** Kills Windows targets after checking each one's identity; see windowsKillScript. */
export async function killWindowsTargets(targets: ProcessEntry[]): Promise<void> {
  if (targets.length === 0) return;
  await windowsPowerShell(windowsKillScript(targets));
}

/** Snapshot of the processes this user can see, with each one's run marker (POSIX) or creation time (Windows). */
export async function readProcessTable(marker: string): Promise<ProcessEntry[]> {
  assert(/^[A-Za-z0-9-]+$/.test(marker), 'marker must be a plain token');
  if (process.platform === 'win32') return parseWindowsTable(await windowsPowerShell(WINDOWS_QUERY));
  if (process.platform === 'linux') {
    const pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number);
    const entries = await Promise.all(pids.map((pid) => readLinuxEntry(pid, marker)));
    return entries.filter((entry): entry is ProcessEntry => entry !== null);
  }
  return parsePsTable(await execText('/bin/ps', ['-E', '-ww', '-A', '-o', 'pid=,ppid=,command=']), marker);
}
