import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, createReadStream, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const DIAGNOSTIC_LOG_BYTES = 16 * 1024;

function launch(executable, log, env) {
  const logFd = openSync(log, 'w');
  try {
    return spawn(executable, ['-ApplePersistenceIgnoreState', 'YES'], {
      detached: true,
      env,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
}

function readLogTail(log) {
  const fd = openSync(log, 'r');
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile(), 'Delve logs must be written to a regular file');
    assert.ok(Number.isSafeInteger(stat.size) && stat.size >= 0, 'Delve log size must be a valid byte count');
    const buffer = Buffer.alloc(Math.min(stat.size, DIAGNOSTIC_LOG_BYTES));
    const count = readSync(fd, buffer, 0, buffer.length, stat.size - buffer.length);
    return { text: buffer.toString('utf8', 0, count), truncated: stat.size > DIAGNOSTIC_LOG_BYTES };
  } finally {
    closeSync(fd);
  }
}

async function assertLogMarker(log, marker, message, start = 0) {
  assert.ok(marker.length > 1, 'Delve log marker must be longer than one character');
  assert.ok(Number.isSafeInteger(start) && start >= 0, 'Delve log offset must be a nonnegative byte count');
  const end = statSync(log).size - 1;
  if (end < start) throw new Error(message);
  try {
    const stream = createReadStream(log, { encoding: 'utf8', start, end, signal: AbortSignal.timeout(2_000) });
    let overlap = '';
    for await (const chunk of stream) {
      const text = overlap + chunk;
      if (text.includes(marker)) return;
      overlap = text.slice(1 - marker.length);
    }
  } catch (cause) {
    throw new Error(message, { cause });
  }
  throw new Error(message);
}

async function waitForExit(exited, timeout) {
  const timer = new AbortController();
  try {
    return await Promise.race([exited, delay(timeout, null, { signal: timer.signal })]);
  } finally {
    timer.abort();
  }
}

function snapshotGroup(pid) {
  if (pid === undefined) return 'Delve process group at failure (PGID unknown)';
  const title = `Delve process group at failure (PGID ${pid}):`;
  try {
    const listing = execFileSync('ps', ['-axo', 'pid,ppid,pgid,stat,comm'], {
      encoding: 'utf8', timeout: 1_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    const [header, ...rows] = listing.trimEnd().split('\n');
    const members = rows.filter(row => Number(row.trim().split(/\s+/, 3)[2]) === pid);
    const omitted = members.length > 40 ? `\n${members.length - 40} other group members omitted` : '';
    return [title, header, ...members.slice(0, 40)].join('\n') + omitted;
  } catch (error) {
    return `${title}\nCould not list process group: ${error.code ?? error.message}`;
  }
}

function reportFailure(snapshot, log, killedGroup) {
  if (snapshot) console.error(snapshot);
  if (killedGroup !== undefined) console.error(`Sent SIGKILL to Delve process group ${killedGroup}.`);
  try {
    const { text, truncated } = readLogTail(log);
    const label = truncated ? ` (last ${DIAGNOSTIC_LOG_BYTES} bytes)` : '';
    console.error(`Delve stdout and stderr${label}:\n${text}`);
  } catch (error) {
    console.error('Could not read Delve output:', error);
  }
}

async function killGroup(child, exited) {
  if (child.pid === undefined) return;
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1, 'Delve must have a valid process group ID');
  assert.notEqual(child.pid, process.pid, 'Delve must be outside the smoke runner process group');
  let killedGroup;
  try {
    process.kill(-child.pid, 'SIGKILL');
    killedGroup = child.pid;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const status = await waitForExit(exited, 1_000);
  assert.notEqual(status, null, `Delve (PID ${child.pid}) did not exit within one second of process group SIGKILL`);
  return killedGroup;
}

async function cleanupFailure(child, exited, log) {
  let snapshot;
  let killedGroup;
  try {
    snapshot = snapshotGroup(child.pid);
  } finally {
    try {
      killedGroup = await killGroup(child, exited);
    } finally {
      child.unref();
      reportFailure(snapshot, log, killedGroup);
    }
  }
}

export async function smoke(executable, log, env, startupMarker, expectedExitCode,
  { startupMs = 10_000, shutdownMs = 15_000 } = {}) {
  assert.ok(Number.isSafeInteger(startupMs) && startupMs > 0, 'startup deadline must be positive');
  assert.ok(Number.isSafeInteger(shutdownMs) && shutdownMs > 0, 'shutdown deadline must be positive');
  const child = launch(executable, log, env);
  const exited = once(child, 'exit');
  try {
    const earlyExit = await waitForExit(exited, startupMs);
    if (earlyExit !== null) {
      const [code, signal] = earlyExit;
      throw new Error(`Delve exited during startup (${signal ?? code}).`);
    }
    await assertLogMarker(log, startupMarker, `Delve did not reach ${startupMarker}`);

    const shutdownLogStart = statSync(log).size;
    assert.ok(child.kill('SIGTERM'), 'Delve must still be running when SIGTERM is sent');
    const shutdown = await waitForExit(exited, shutdownMs);
    assert.notEqual(shutdown, null, `Delve did not exit within ${shutdownMs}ms of SIGTERM`);
    assert.deepEqual(shutdown, [expectedExitCode, null], 'Delve must exit with the expected code after SIGTERM');
    await assertLogMarker(log, '[delve] received SIGTERM', 'Delve did not handle SIGTERM', shutdownLogStart);
  } catch (error) {
    try {
      await cleanupFailure(child, exited, log);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Delve smoke and process group cleanup both failed', { cause: cleanupError });
    }
    throw error;
  }
}
