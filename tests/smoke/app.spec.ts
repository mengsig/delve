import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, shortcut } from './desktop';
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

test('leaves focus and source validity alone when the workspace is already added', async ({ desktop }) => {
  const { page } = desktop;
  await add(page, 'https://github.com/octo/site.git');
  await expect(page.getByRole('heading', { name: 'Repository atlas.' })).toBeVisible();
  await add(page, 'https://github.com/octo/site.git');
  await expect(page.getByRole('alert')).toContainText('workspace switcher');
  await expect(page.getByRole('button', { name: 'Open workspace switcher' })).toBeVisible();
  const source = page.getByLabel('Topic or repository');
  await expect(source).not.toBeFocused();
  await expect(source).not.toHaveAttribute('aria-invalid');
  await expect(source).toHaveAttribute('aria-describedby', 'source-hint');
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
