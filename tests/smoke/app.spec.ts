import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hold, test, shortcut } from './desktop';
import packageInfo from '../../package.json';

async function add(page: Page, value: string, topic = false) {
  await page.getByRole('button', { name: 'Add a workspace', exact: true }).click();
  await page.getByLabel('Topic or repository').fill(value);
  await page.getByRole('button', { name: topic ? 'Start lesson →' : 'Add to atlas →' }).click();
}

test('loads a hardened desktop and persists workspaces added through the source form', async ({ desktop }) => {
  const { page } = desktop;
  await expect(page).toHaveTitle('Delve');
  await expect(page.getByRole('heading', { name: 'Repository atlas.' })).toBeVisible();
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'About Delve' })).toContainText(`Delve ${packageInfo.version}`);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe('undefined');
  expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe('undefined');

  await page.getByRole('button', { name: 'Add a workspace', exact: true }).click();
  await page.getByText('Advanced options', { exact: false }).click();
  await expect(page.locator('[data-provider="claude"]')).toHaveAttribute('data-state', 'not-found');
  await expect(page.locator('[data-provider="codex"]')).toContainText('CLI not found');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await add(page, 'Photography', true);
  await expect(page.getByRole('heading', { name: 'Photography', exact: true })).toBeVisible();
  await add(page, 'https://github.com/octo/site.git');
  await expect(page.getByRole('heading', { name: 'Repository atlas.' })).toBeVisible();
  await page.keyboard.press(shortcut);
  const dialog = page.getByRole('dialog', { name: 'Go to…' });
  const finder = dialog.getByRole('combobox', { name: 'Search workspaces, views and lessons' });
  await expect(finder).toBeFocused();
  await expect(dialog.getByRole('option', { selected: true })).toContainText('octo/site');
  await finder.fill('Photography');
  await dialog.getByRole('option').filter({ hasText: /^PhotographyTopic/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Topic atlas.' })).toBeVisible();
  const again = await desktop.restart();
  await expect(again.getByRole('heading', { name: 'Topic atlas.' })).toBeVisible();
  await again.keyboard.press(shortcut);
  await expect(again.getByRole('option', { name: 'Atlas View', exact: true })).toBeVisible();
  await expect(again.getByRole('option', { selected: true })).toContainText('Photography');
});

test('validates a local working tree and exposes the new empty atlas', async ({ desktop }) => {
  const { page, directory } = desktop;
  await add(page, directory);
  await expect(page.getByRole('alert')).toContainText('not a Git repository');
  const source = page.getByLabel('Topic or repository');
  await expect(source).toBeFocused();
  await expect(source).toHaveAttribute('aria-invalid', 'true');
  await expect(source).toHaveAttribute('aria-describedby', 'source-hint setup-error');
  await expect(page.locator('#setup-error')).toContainText('not a Git repository');
  const folder = join(directory, 'local-repository');
  mkdirSync(join(folder, '.git'), { recursive: true });
  await source.fill(folder);
  await expect(source).not.toHaveAttribute('aria-invalid');
  await expect(source).toHaveAttribute('aria-describedby', 'source-hint');
  await page.getByRole('button', { name: 'Add to atlas →' }).click();
  await expect(page.getByRole('heading', { name: 'Repository atlas.' })).toBeVisible();
  await expect(page.getByText('local-repository', { exact: false }).first()).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
});

async function failChannel(application: ElectronApplication, channel: string, message: string) {
  await application.evaluate(({ ipcMain }, { name, text }) => {
    ipcMain.removeHandler(name);
    // A source-like code proves the failing action, not the code, decides whether the source is blamed.
    ipcMain.handle(name, async () => ({ ok: false, error: { code: 'INVALID_REQUEST', message: text } }));
  }, { name: channel, text: message });
}

function focusedId(page: Page) {
  return page.evaluate(() => document.activeElement === document.body ? 'body' : document.activeElement?.id || document.activeElement?.textContent);
}

async function expectUnmarked(source: Locator) {
  await expect(source).not.toBeFocused();
  await expect(source).not.toHaveAttribute('aria-invalid');
  await expect(source).toHaveAttribute('aria-describedby', 'source-hint');
}

test('marks an already added source without taking focus from the switcher opener', async ({ desktop }) => {
  const { page, application } = desktop;
  await add(page, 'https://github.com/octo/site.git');
  await expect(page.getByRole('heading', { name: 'Repository atlas.' })).toBeVisible();
  const release = await hold(application, 'workspaces:add');
  const opener = page.locator('header').getByRole('button', { name: 'Switch workspace', exact: true });
  await add(page, 'https://github.com/octo/site.git');
  await expect(page.getByRole('button', { name: 'Opening…' })).toBeDisabled();
  await opener.focus();
  await release.evaluate(resume => resume());
  await expect(page.getByRole('alert')).toContainText('workspace switcher');
  await expect(page.getByRole('button', { name: 'Open workspace switcher' })).toBeVisible();
  await expect(opener).toBeFocused();
  const source = page.getByLabel('Topic or repository');
  await expect(source).toHaveAttribute('aria-invalid', 'true');
  await expect(source).toHaveAttribute('aria-describedby', 'source-hint setup-error');
});

test('keeps focus where the user moved it when a delayed source rejection arrives', async ({ desktop }) => {
  const { page, application, directory } = desktop;
  const release = await hold(application, 'workspaces:add');
  const source = page.getByLabel('Topic or repository');
  const submit = page.getByRole('button', { name: /Add to atlas →|Opening…/ });
  const opener = page.locator('header').getByRole('button', { name: 'Switch workspace', exact: true });
  await add(page, directory);
  await expect(page.getByRole('button', { name: 'Opening…' })).toBeDisabled();
  await opener.focus();
  await release.evaluate(resume => resume());
  await expect(page.getByRole('alert')).toContainText('not a Git repository');
  await expect(source).toHaveAttribute('aria-invalid', 'true');
  await expect(opener).toBeFocused();
  await expect(source).not.toBeFocused();

  await submit.click();
  await expect(page.getByRole('button', { name: 'Opening…' })).toBeDisabled();
  await expect(source).toHaveAttribute('aria-invalid', 'true');
  // A press on plain header text moves focus to the page without a focusin, so only the press reveals the move.
  await page.locator('header').getByText('Workspace setup', { exact: true }).click();
  expect(await focusedId(page)).toBe('body');
  await release.evaluate(resume => resume());
  await expect(page.getByRole('alert')).toContainText('not a Git repository');
  await expect(source).toHaveAttribute('aria-invalid', 'true');
  expect(await focusedId(page)).toBe('body');
  await expect(source).not.toBeFocused();
});

test('leaves focus and source validity alone when the folder picker or a drop fails', async ({ desktop }) => {
  const { page, application } = desktop;
  await failChannel(application, 'workspaces:pick-folder', 'The folder dialog is unavailable.');
  await page.getByRole('button', { name: 'Add a workspace', exact: true }).click();
  const source = page.getByLabel('Topic or repository');
  await expect(source).toBeFocused();
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByRole('alert')).toHaveText('Could not choose a folder. The folder dialog is unavailable.');
  await expectUnmarked(source);
  expect(['body', 'Choose folder…']).toContain(await focusedId(page));

  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.focus();
  await page.locator('.source-control').evaluate(control => {
    const data = new DataTransfer();
    data.setData('text/plain', 'not a repository');
    control.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('alert')).toContainText('Could not read that drop.');
  await expectUnmarked(source);
  await expect(cancel).toBeFocused();
});

test('switcher supports filtering, keyboard navigation, cancellation and focus restoration', async ({ desktop }) => {
  const { page } = desktop;
  const opener = page.locator('header').getByRole('button', { name: 'Switch workspace', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog');
  const finder = dialog.getByRole('combobox');
  await expect(finder).toBeFocused();
  await finder.fill('no matching workspace');
  await expect(dialog.getByRole('status')).toContainText('No matches');
  await finder.fill('');
  const first = await dialog.getByRole('option', { selected: true }).innerText();
  await finder.press('ArrowDown');
  await expect(dialog.getByRole('option', { selected: true })).not.toHaveText(first);
  await finder.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await page.keyboard.press(shortcut);
  await finder.fill('Relay');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await finder.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.topline')).toContainText('Relay');
});
