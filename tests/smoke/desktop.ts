import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeShimDir, shimEnv } from '../../src/main/providers/test-helpers';
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';

interface Desktop {
  page: Page;
  directory: string;
  restart: () => Promise<Page>;
}

function launch(userData: string, fakeBin?: string): Promise<ElectronApplication> {
  const providerEnv = fakeBin ? shimEnv(fakeBin, { FAKE_PROVIDER_RESPONSE_FILE: join(userData, 'reply.json'),
    FAKE_PROVIDER_GATE: join(userData, 'gate'), FAKE_PROVIDER_RECORD: join(userData, 'request.json') }) : { PATH: '/nonexistent' };
  const env = { ...process.env, ...providerEnv, DELVE_USER_DATA_DIR: userData };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RENDERER_URL;
  return electron.launch({ args: [resolve(__dirname, '../../out/main/index.js')], env, timeout: 30_000 });
}

export const test = base.extend<{ desktop: Desktop; tutorCli: boolean }>({
  tutorCli: [false, { option: true }],
  desktop: async ({ tutorCli }, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'delve-smoke-'));
    let fakeBin: string | undefined;
    let app: ElectronApplication | undefined;
    async function start() {
      app = await launch(directory, fakeBin);
      const page = await app.firstWindow();
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      return page;
    }
    try {
      fakeBin = tutorCli ? await makeShimDir() : undefined;
      await use({
        directory, page: await start(),
        restart: async () => { await app?.close(); app = undefined; return start(); },
      });
    } finally {
      await app?.close();
      if (fakeBin) rmSync(fakeBin, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

export const shortcut = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
