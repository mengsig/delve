import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import electron from 'electron';

test('SIGTERM closes a startup error dialog', async () => {
  test.skip(process.platform === 'win32', 'Uses POSIX signals.');
  const directory = mkdtempSync(join(tmpdir(), 'delve-startup-error-'));
  mkdirSync(join(directory, 'delve.sqlite'));
  const child = spawn(electron as unknown as string, [resolve('out/main/index.js')], {
    env: { ...process.env, DELVE_USER_DATA_DIR: directory }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk; });
  const exited = once(child, 'exit');
  try {
    await expect.poll(() => log, { timeout: 10_000 }).toContain('[delve] error dialog open');
    expect(log).toContain('[delve] startup failed');
    expect(child.kill('SIGTERM')).toBe(true);
    await expect(Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000))]))
      .resolves.toEqual([0, null]);
    expect(log).toContain('[delve] received SIGTERM');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
