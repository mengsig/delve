import { expect } from '@playwright/test';
import { test } from './desktop';

test('explains how to start when there is no personal knowledge', async ({ desktop: { page } }) => {
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your knowledge, connected' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a workspace', exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Explore the demo map' }).click();
  await expect(page.getByRole('button', { name: 'Start Worker leases' })).toBeEnabled();
  await expect(page.locator('.knowledge-area-progress')).toContainText('2 of 6');
  await page.getByRole('button', { name: '← Personal knowledge' }).click();
  await expect(page.getByRole('heading', { name: 'Your knowledge, connected' })).toBeVisible();
});
