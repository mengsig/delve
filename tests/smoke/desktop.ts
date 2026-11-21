import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';

interface Desktop {
  page: Page;
  directory: string;
  restart: () => Promise<Page>;
}

function launch(userData: string): Promise<ElectronApplication> {
  const env = { ...process.env, DELVE_USER_DATA_DIR: userData, PATH: '/nonexistent' };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RENDERER_URL;
  return electron.launch({ args: [resolve(__dirname, '../../out/main/index.js')], env, timeout: 30_000 });
}

export const test = base.extend<{ desktop: Desktop }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
  desktop: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'delve-smoke-'));
    let app: ElectronApplication | undefined;
    async function start() {
      app = await launch(directory);
      const page = await app.firstWindow();
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      return page;
    }
    try {
      await use({
        directory, page: await start(),
        restart: async () => { await app?.close(); app = undefined; return start(); },
      });
    } finally {
      await app?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

export const shortcut = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
