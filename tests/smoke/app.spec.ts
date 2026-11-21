import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const mainEntry = resolve(__dirname, '../../out/main/index.js');

let userData: string;

function launch(): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value;
  }
  env['DELVE_USER_DATA_DIR'] = userData;
  env['PATH'] = '/nonexistent';
  return electron.launch({
    args: [mainEntry],
    env,
    timeout: 30_000,
  });
}

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'delve-smoke-'));
});

test.afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

test('window loads hardened, adds and switches workspaces that persist', async () => {
  const app = await launch();
  const window = await app.firstWindow();
  await expect(window).toHaveTitle('Delve');
  await expect(window.getByRole('heading', { name: 'Delve', level: 1 })).toBeVisible();
  expect(await window.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe('undefined');
  expect(await window.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe('undefined');

  await expect(window.locator('[data-provider="claude"]')).toHaveAttribute('data-state', 'not-found');
  await expect(window.locator('[data-provider="codex"]')).toContainText('not found');

  const source = window.getByLabel('Source');
  await source.fill('Photography');
  await window.getByRole('button', { name: 'Add workspace' }).click();
  await expect(window.getByTestId('active-workspace')).toHaveText('Active: Photography');

  await window.getByLabel('Kind').selectOption('github');
  await source.fill('octo/site');
  await window.getByRole('button', { name: 'Add workspace' }).click();
  await expect(window.getByTestId('active-workspace')).toHaveText('Active: octo/site');

  await window.getByRole('button', { name: 'Switch to Photography' }).click();
  await expect(window.getByTestId('active-workspace')).toHaveText('Active: Photography');

  // R3: the shortcut focuses the workspace switcher, which then switches workspace.
  await window.locator('body').click();
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  const switcher = window.getByLabel('Switch workspace');
  await expect(switcher).toBeFocused();
  await switcher.selectOption({ label: 'octo/site' });
  await expect(window.getByTestId('active-workspace')).toHaveText('Active: octo/site');
  await window.getByRole('button', { name: 'Switch to Photography' }).click();
  await expect(window.getByTestId('active-workspace')).toHaveText('Active: Photography');
  await app.close();

  const reopened = await launch();
  const again = await reopened.firstWindow();
  await expect(again.getByTestId('active-workspace')).toHaveText('Active: Photography');
  await expect(again.getByRole('list', { name: 'Workspaces' }).getByRole('listitem')).toHaveCount(2);
  await reopened.close();
});

test('rejects invalid input with a visible error', async () => {
  const app = await launch();
  const window = await app.firstWindow();
  await window.getByLabel('Kind').selectOption('git');
  await window.getByLabel('Source').fill(userData);
  await window.getByRole('button', { name: 'Add workspace' }).click();
  await expect(window.getByRole('alert')).toContainText('not a Git repository');
  await app.close();
});
