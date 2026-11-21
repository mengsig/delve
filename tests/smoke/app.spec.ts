import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, shortcut } from './desktop';

async function add(page: Page, kind: string, value: string) {
  await page.getByRole('button', { name: '+ Add', exact: true }).click();
  await page.getByRole('button', { name: kind, exact: true }).click();
  await page.getByLabel(kind, { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Add to atlas →' }).click();
}

test('loads a hardened desktop and persists workspaces added through the source form', async ({ desktop }) => {
  const { page } = desktop;
  await expect(page).toHaveTitle('Delve');
  await expect(page.getByRole('heading', { name: 'Repository atlas.' })).toBeVisible();
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe('undefined');
  expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe('undefined');

  await page.getByRole('button', { name: '+ Add', exact: true }).click();
  await expect(page.locator('[data-provider="claude"]')).toHaveAttribute('data-state', 'not-found');
  await expect(page.locator('[data-provider="codex"]')).toContainText('CLI not found');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await add(page, 'Any topic', 'Photography');
  await expect(page.getByRole('heading', { name: 'Topic atlas.' })).toBeVisible();
  await add(page, 'GitHub URL', 'https://github.com/octo/site.git');
  await expect(page.getByRole('heading', { name: 'Repository atlas.' })).toBeVisible();
  await page.keyboard.press(shortcut);
  const dialog = page.getByRole('dialog', { name: 'Switch workspace' });
  const finder = dialog.getByRole('combobox', { name: 'Find a workspace' });
  await expect(finder).toBeFocused();
  await expect(dialog.getByRole('option', { selected: true })).toContainText('octo/site');
  await finder.fill('Photography');
  await dialog.getByRole('option').filter({ has: page.getByText('Photography', { exact: true }) }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Topic atlas.' })).toBeVisible();
  const again = await desktop.restart();
  await expect(again.getByRole('heading', { name: 'Topic atlas.' })).toBeVisible();
  await again.keyboard.press(shortcut);
  await expect(again.getByRole('option')).toHaveCount(5);
  await expect(again.getByRole('option', { selected: true })).toContainText('Photography');
});

test('validates a local working tree and exposes the new empty atlas', async ({ desktop }) => {
  const { page, directory } = desktop;
  await add(page, 'Local folder', directory);
  await expect(page.getByRole('alert')).toContainText('not a Git repository');
  const folder = join(directory, 'local-repository');
  mkdirSync(join(folder, '.git'), { recursive: true });
  await page.getByLabel('Local folder', { exact: true }).fill(folder);
  await page.getByRole('button', { name: 'Add to atlas →' }).click();
  await expect(page.getByRole('heading', { name: 'Repository atlas.' })).toBeVisible();
  await expect(page.getByText('local-repository', { exact: false }).first()).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
});

test('switcher supports filtering, keyboard navigation, cancellation and focus restoration', async ({ desktop }) => {
  const { page } = desktop;
  const opener = page.locator('header').getByRole('button', { name: 'Switch workspace', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog');
  const finder = dialog.getByRole('combobox');
  await expect(finder).toBeFocused();
  await finder.fill('no matching workspace');
  await expect(dialog.getByRole('status')).toContainText('No workspace matches');
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
