import { expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { test } from './desktop';

test('explains how to start and shows portable evidence in the demo map', async ({ desktop: { page, application } }) => {
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your knowledge, connected' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a workspace', exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Explore the demo map' }).click();
  await expect(page.getByRole('button', { name: 'Start Worker leases' })).toBeEnabled();
  await expect(page.locator('.knowledge-area-progress')).toContainText('2 of 6');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByLabel('Workspace area').selectOption({ label: 'All workspaces' });
  await page.getByRole('button', { name: 'Find a concept' }).click();
  await page.getByLabel('Search', { exact: true }).fill('Durable queue');
  const queue = page.getByRole('button', { name: 'Durable queue', exact: true });
  await expect(queue).toHaveCount(1);
  await queue.click();
  await page.getByLabel('Search', { exact: true }).clear();
  const usage = page.getByRole('region', { name: 'Used in' });
  await expect(usage.getByRole('listitem')).toHaveText(['Archon', 'Relay']);
  await expect(page.getByText('Shared across repositories', { exact: true })).toBeVisible();
  await expect(page.getByText('Deepest verified depth: low.', { exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.knowledge-map canvas').evaluate(canvas => {
    const element = canvas as HTMLCanvasElement;
    return element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data.some((value, index) => index % 4 === 3 && value > 0);
  })).toBe(true);
  mkdirSync('.archon/evidence', { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ path: `.archon/evidence/global-concepts-${theme}.png` });
  }
  await page.getByLabel('Workspace area').selectOption({ label: 'Archon' });
  await page.getByLabel('Search', { exact: true }).fill('Durable queue');
  await queue.click();
  await expect(page.locator('.knowledge-detail').getByRole('button', { name: 'Worker leases', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← Personal knowledge' }).click();
  await expect(page.getByRole('heading', { name: 'Your knowledge, connected' })).toBeVisible();
});
