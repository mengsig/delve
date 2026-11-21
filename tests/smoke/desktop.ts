import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { delimiter, dirname, join, resolve } from 'node:path';
import { findExecutable } from '../../src/main/providers/which';
import { makeShimDir, shimEnv } from '../../src/main/providers/test-helpers';
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';

interface Desktop {
  page: Page;
  directory: string;
  restart: (link?: string) => Promise<Page>;
}

async function launch(userData: string, firstRun: boolean, fakeBin?: string, link?: string): Promise<ElectronApplication> {
  const providerEnv = fakeBin ? shimEnv(fakeBin, { FAKE_PROVIDER_RESPONSE_FILE: join(userData, 'reply.json'),
    FAKE_PROVIDER_GATE: join(userData, 'gate'), FAKE_PROVIDER_RECORD: join(userData, 'request.json') }) : { PATH: '/nonexistent' };
  if (firstRun && fakeBin) {
    const git = await findExecutable('git', process.env);
    if (!git) throw new Error('Repository smoke requires Git.');
    providerEnv.PATH += delimiter + dirname(git);
  }
  const env = { ...process.env, ...providerEnv, DELVE_USER_DATA_DIR: userData };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RENDERER_URL;
  return electron.launch({ args: [resolve(__dirname, '../../out/main/index.js'), ...(link ? [link] : [])], env, timeout: 30_000 });
}

export const test = base.extend<{ desktop: Desktop; tutorCli: boolean; firstRun: boolean; fixtureGitHub: boolean }>({
  tutorCli: [false, { option: true }],
  firstRun: [false, { option: true }],
  fixtureGitHub: [false, { option: true }],
  desktop: async ({ tutorCli, firstRun, fixtureGitHub }, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'delve-smoke-'));
    let fakeBin: string | undefined;
    let app: ElectronApplication | undefined;
    async function start(link?: string) {
      app = await launch(directory, firstRun, fakeBin, link);
      const page = await app.firstWindow();
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      return page;
    }
    try {
      fakeBin = tutorCli ? await makeShimDir() : undefined;
      if (fixtureGitHub) {
        if (!fakeBin || process.platform === 'win32') throw new Error('The GitHub smoke fixture requires a POSIX shim directory.');
        const script = pathToFileURL(resolve(__dirname, '../fixtures/fake-cli/github.mjs')).href;
        const fixture = join(directory, 'github.json');
        writeFileSync(join(fakeBin, 'gh'), '#!' + process.execPath + '\nprocess.argv.splice(2, 0, ' + JSON.stringify(fixture)
          + ');import(' + JSON.stringify(script) + ');\n', { mode: 0o755 });
      }
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
