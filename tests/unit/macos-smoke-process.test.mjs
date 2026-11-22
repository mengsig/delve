import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { smoke } from '../../scripts/macos-smoke-process.mjs';

const app = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync, writeSync } = require('node:fs');
const mode = process.env.FIXTURE_MODE;
process.on('SIGTERM', () => {
  if (mode === 'timeout') writeSync(1, 'x'.repeat(256 * 1024) + '\\n');
  writeSync(1, 'fixture received SIGTERM\\n');
  if (mode === 'wrong exit') process.exit(7);
  if (mode === 'clean') {
    writeSync(1, '[delve] received SIGTERM\\n');
    helper.once('exit', () => process.exit(0));
    helper.kill('SIGTERM');
  }
});
const helper = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(91), 8000)'], { stdio: 'ignore' });
writeFileSync(process.env.FIXTURE_PIDS, JSON.stringify([process.pid, helper.pid]));
if (mode === 'clean') writeSync(1, 'x'.repeat(17 * 64 * 1024 - 4));
writeSync(1, 'fixture app ready\\n');
setTimeout(() => process.exit(91), 8000);
`;

function runningPids(pids) {
  const ps = spawnSync('ps', ['-p', pids.join(','), '-o', 'pid=', '-o', 'stat='], {
    encoding: 'utf8', timeout: 500, killSignal: 'SIGKILL',
  });
  expect(ps.error).toBeUndefined();
  expect([0, 1]).toContain(ps.status);
  return ps.stdout.trim().split('\n').flatMap(line => {
    const [pid, state] = line.trim().split(/\s+/);
    return state && !state.startsWith('Z') ? [Number(pid)] : [];
  });
}

function readFixturePids(pidFile) {
  const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
  expect(pids).toHaveLength(2);
  expect(pids.every(pid => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid)).toBe(true);
  return pids;
}

function stopFixture(pidFile) {
  if (!existsSync(pidFile)) return;
  for (const pid of runningPids(readFixturePids(pidFile))) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

it.skipIf(process.platform === 'win32').each([
  { title: 'kills the group and bounds diagnostics on shutdown timeout', mode: 'timeout',
    failure: 'Delve did not exit within 1000ms of SIGTERM' },
  { title: 'kills the remaining helper after an unexpected exit', mode: 'wrong exit',
    failure: 'Delve must exit with the expected code after SIGTERM' },
  { title: 'accepts startup and shutdown markers after more than 1 MiB of output', mode: 'clean' },
])('$title', async ({ failure, mode }) => {
  const directory = mkdtempSync(join(tmpdir(), 'delve-mac-smoke-test-'));
  const executable = join(directory, 'Delve');
  const log = join(directory, 'launch.log');
  const pidFile = join(directory, 'pids');
  const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    writeFileSync(executable, app, { mode: 0o700 });
    const env = { ...process.env, FIXTURE_PIDS: pidFile, FIXTURE_MODE: mode };
    const result = smoke(executable, log, env, 'fixture app ready', 0, { startupMs: 1_500, shutdownMs: 1_000 });
    if (!failure) {
      await expect(result).resolves.toBeUndefined();
      expect(statSync(log).size).toBeGreaterThan(1024 * 1024);
      expect(diagnostics).not.toHaveBeenCalled();
      expect(runningPids(readFixturePids(pidFile))).toEqual([]);
      return;
    }
    await expect(result).rejects.toThrow(failure);

    const pids = readFixturePids(pidFile);
    const output = diagnostics.mock.calls.flat().join('\n');
    expect(output).toContain(`Delve process group at failure (PGID ${pids[0]})`);
    expect(output).toMatch(new RegExp(`^\\s*${pids[1]}\\s+`, 'm'));
    expect(output).toContain('fixture received SIGTERM');
    expect(output).toContain(`Sent SIGKILL to Delve process group ${pids[0]}`);
    if (mode === 'timeout') {
      expect(statSync(log).size).toBeGreaterThan(256 * 1024);
      expect(output).toContain('Delve stdout and stderr (last 16384 bytes)');
      expect(output.length).toBeLessThan(20_000);
    }
    await expect.poll(() => runningPids(pids), { timeout: 500 }).toEqual([]);
  } finally {
    diagnostics.mockRestore();
    try {
      stopFixture(pidFile);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 7_000);
