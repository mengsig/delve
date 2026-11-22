import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

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

function reportFailure(pid, log) {
  console.error(`Delve process group at failure (PGID ${pid ?? 'unknown'}):`);
  if (pid !== undefined) {
    try {
      const listing = execFileSync('ps', ['-axo', 'pid,ppid,pgid,stat,command'], {
        encoding: 'utf8', timeout: 1_000, killSignal: 'SIGKILL',
      });
      const [header, ...rows] = listing.trimEnd().split('\n');
      const members = rows.filter(row => Number(row.trim().split(/\s+/, 3)[2]) === pid);
      console.error([header, ...members].join('\n'));
    } catch (error) {
      console.error('Could not list process group:', error);
    }
  }
  try {
    console.error('Delve stdout and stderr:\n' + readFileSync(log, 'utf8'));
  } catch (error) {
    console.error('Could not read Delve output:', error);
  }
}

async function killGroup(child, exited) {
  if (child.pid === undefined) return;
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1, 'Delve must have a valid process group ID');
  assert.notEqual(child.pid, process.pid, 'Delve must be outside the smoke runner process group');
  try {
    process.kill(-child.pid, 'SIGKILL');
    console.error(`Sent SIGKILL to Delve process group ${child.pid}.`);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const status = await Promise.race([exited, delay(1_000, null, { ref: false })]);
  assert.notEqual(status, null, `Delve (PID ${child.pid}) did not exit within one second of process group SIGKILL`);
}

export async function smoke(executable, log, env, startupMarker, expectedExitCode,
  { startupMs = 10_000, shutdownMs = 15_000 } = {}) {
  assert.ok(Number.isSafeInteger(startupMs) && startupMs > 0, 'startup deadline must be positive');
  assert.ok(Number.isSafeInteger(shutdownMs) && shutdownMs > 0, 'shutdown deadline must be positive');
  const child = launch(executable, log, env);
  const exited = once(child, 'exit');
  try {
    const earlyExit = await Promise.race([exited, delay(startupMs, null, { ref: false })]);
    if (earlyExit !== null) {
      const [code, signal] = earlyExit;
      throw new Error(`Delve exited during startup (${signal ?? code}).`);
    }
    assert.ok(readFileSync(log, 'utf8').includes(startupMarker), `Delve did not reach ${startupMarker}`);

    assert.ok(child.kill('SIGTERM'), 'Delve must still be running when SIGTERM is sent');
    const shutdown = await Promise.race([exited, delay(shutdownMs, null, { ref: false })]);
    assert.notEqual(shutdown, null, `Delve did not exit within ${shutdownMs}ms of SIGTERM`);
    assert.deepEqual(shutdown, [expectedExitCode, null], 'Delve must exit with the expected code after SIGTERM');
    assert.ok(readFileSync(log, 'utf8').includes('[delve] received SIGTERM'), 'Delve did not handle SIGTERM');
  } catch (error) {
    reportFailure(child.pid, log);
    try {
      await killGroup(child, exited);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Delve smoke and process group cleanup both failed', { cause: cleanupError });
    } finally {
      child.unref();
    }
    throw error;
  }
}
