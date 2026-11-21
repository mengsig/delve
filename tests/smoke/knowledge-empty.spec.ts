import { expect } from '@playwright/test';
import { test } from './desktop';

test('explains how to start when there is no personal knowledge', async ({ desktop: { page } }) => {
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your knowledge, connected' })).toBeVisible();
  await expect(page.getByText(/Add a workspace to begin/)).toBeVisible();
});
