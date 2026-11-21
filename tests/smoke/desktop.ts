import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { findExecutable } from '../../src/main/providers/which';
import { makeShimDir, shimEnv } from '../../src/main/providers/test-helpers';
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';

interface Desktop {
  page: Page;
  directory: string;
  restart: (link?: string) => Promise<Page>;
}

async function launch(userData: string, firstRun: boolean, fakeBin?: string, link?: string, providerMode?: string): Promise<ElectronApplication> {
  const providerEnv = fakeBin ? shimEnv(fakeBin, { FAKE_PROVIDER_RESPONSE_FILE: join(userData, 'reply.json'),
    FAKE_PROVIDER_GATE: join(userData, 'gate'), FAKE_PROVIDER_RECORD: join(userData, 'request.json'),
    ...(providerMode ? { FAKE_PROVIDER_MODE: providerMode } : {}) }) : { PATH: '/nonexistent' };
  if (firstRun && fakeBin) {
    const git = await findExecutable('git', process.env);
    if (!git) throw new Error('Repository smoke requires Git.');
    providerEnv.PATH += delimiter + dirname(git);
  }
  const env = { ...process.env, ...providerEnv, CODEX_HOME: join(userData, 'codex-home'), DELVE_USER_DATA_DIR: userData };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RENDERER_URL;
  return electron.launch({ args: [resolve(__dirname, '../../out/main/index.js'), ...(link ? [link] : [])], env, timeout: 30_000 });
}

export const test = base.extend<{ desktop: Desktop; tutorCli: boolean; firstRun: boolean; providerMode: string | undefined }>({
  tutorCli: [false, { option: true }],
  firstRun: [false, { option: true }],
  providerMode: [undefined, { option: true }],
  desktop: async ({ tutorCli, firstRun, providerMode }, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'delve-smoke-'));
    let fakeBin: string | undefined;
    let app: ElectronApplication | undefined;
    async function start(link?: string) {
      app = await launch(directory, firstRun, fakeBin, link, providerMode);
      const page = await app.firstWindow();
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      return page;
    }
    try {
      fakeBin = tutorCli ? await makeShimDir() : undefined;
      const page = await start();
      if (!firstRun) await page.getByRole('button', { name: 'Explore demo atlas' }).click();
      await use({
        directory, page,
        restart: async link => { await app?.close(); app = undefined; return start(link); },
      });
    } finally {
      await app?.close();
      if (fakeBin) rmSync(fakeBin, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

export const shortcut = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
