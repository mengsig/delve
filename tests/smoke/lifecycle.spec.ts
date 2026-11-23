import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect } from '@playwright/test';
import { test } from './desktop';

function procState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat[stat.lastIndexOf(')') + 2];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function providerPid(directory: string, file: string): Promise<number> {
  const filename = join(directory, file);
  await expect.poll(() => existsSync(filename)).toBe(true);
  const pid = Number(readFileSync(filename, 'utf8'));
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  return pid;
}

const running = (pid: number): boolean => {
  const state = procState(pid);
  return state !== undefined && state !== 'Z';
};

test.skip(process.platform !== 'linux', 'Uses Linux process state and POSIX signals.');
test.use({ tutorCli: true, providerMode: 'ignore-term' });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} drains provider processes and closes the application database`, async ({ desktop }) => {
    const { application, directory, page } = desktop;
    const database = join(directory, 'delve.sqlite');
    const topic = 'Linux shutdown checks';
    const providerPids: number[] = [];
    try {
      await page.getByRole('button', { name: 'Add a workspace', exact: true }).click();
      await page.getByRole('textbox', { name: 'Topic or repository' }).fill(topic);
      await page.getByRole('button', { name: 'Allow once and start lesson' }).click();
      providerPids.push(await providerPid(directory, 'provider.pid'));
      providerPids.push(await providerPid(directory, 'provider-child.pid'));
      expect(providerPids.every(running)).toBe(true);
      expect(existsSync(database + '-wal')).toBe(true);

      const child = application.process();
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(15_000) });
      expect(child.kill(signal)).toBe(true);
      await expect(exited).resolves.toEqual([0, null]);
      await expect.poll(() => providerPids.some(running)).toBe(false);
      expect(existsSync(database + '-wal')).toBe(false);
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        expect(db.prepare('SELECT name FROM workspaces WHERE name = ?').get(topic)).toEqual({ name: topic });
      } finally {
        db.close();
      }
    } finally {
      for (const pid of providerPids) if (running(pid)) process.kill(pid, 'SIGKILL');
    }
  });
}
