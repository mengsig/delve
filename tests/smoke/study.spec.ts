import { expect } from '@playwright/test';
import { test } from './desktop';

test('navigates the same graph by keyboard on the terrain and in Folio', async ({ desktop: { page } }) => {
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(6);
  const inspector = page.getByRole('region', { name: 'Selected concept' });
  await expect(inspector).toContainText('Worker leases');
  const viewport = page.locator('.react-flow__viewport');
  const transform = () => viewport.getAttribute('style');
  const start = await transform();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(transform).not.toBe(start);
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  const journal = nodes.getByRole('button', { name: /^Event journal,/ });
  await journal.focus();
  await journal.press('Enter');
  await expect(inspector).toContainText('Event journal');
  await expect(nodes.getByRole('button', { name: /Worker leases,.*Recommended next/ })).toHaveClass(/next/);
  await page.getByRole('button', { name: 'Ledger', exact: true }).click();
  const ledger = page.getByRole('region', { name: 'Folio dependency ledger' });
  await expect(ledger).toContainText('Durable queue');
  await expect(ledger).toContainText('Requires');
  await expect(inspector).toContainText('Event journal');
  await inspector.getByRole('button', { name: 'Open lesson →' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Event journal' })).toBeVisible();
  await page.getByRole('button', { name: '← Back to atlas' }).click();
  await expect(inspector).toContainText('Event journal');
});

test('lesson depth, local conversations and linked change concepts work offline', async ({ desktop: { page } }) => {
  await page.getByRole('button', { name: 'Open lesson →' }).click();
  await expect(page.getByRole('heading', { name: 'Worker leases', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Low · Protocol detail' }).click();
  await expect(page.getByRole('heading', { name: 'No environment in this lesson' })).toBeVisible();
  await expect(page.locator('pre mark')).toBeVisible();
  await page.getByRole('textbox', { name: 'Ask the demo tutor' }).fill('How does the result writer check ownership?');
  await page.getByRole('button', { name: 'Ask question' }).click();
  await expect(page.getByRole('log')).toContainText('How does the result writer check ownership?');
  await page.getByRole('button', { name: 'Task ID and active generation' }).click();
  await expect(page.getByText(/Connection learned\./).first()).toBeVisible();
  await page.getByRole('button', { name: '← Back to atlas' }).click();
  await page.getByRole('button', { name: 'Open lesson →' }).click();
  await expect(page.getByRole('log')).toContainText('How does the result writer check ownership?');
  await page.getByRole('navigation', { name: 'Application' }).getByRole('button', { name: 'Changes' }).click();
  await expect(page.getByRole('heading', { name: 'Reject late worker results.' })).toBeVisible();
  await page.getByRole('button', { name: 'Explore this concept →' }).click();
  await expect(page.getByRole('heading', { name: 'Write fencing', level: 1 })).toBeVisible();
});

test('shows evidence provenance and resets only the selected depth at its origin', async ({ desktop: { page } }) => {
  await page.getByRole('navigation').getByRole('button', { name: 'Progress' }).click();
  const table = page.getByRole('table');
  const archon = table.getByRole('row').filter({ hasText: 'Archon' });
  await expect(archon).toContainText('2 / 6');
  await page.getByText(/^Inspect .* evidence records$/).click();
  const entry = page.getByRole('listitem').filter({ hasText: 'Durable queue' }).filter({ hasText: 'medium' });
  await entry.getByRole('button', { name: /Manage in Relay/ }).click();
  await expect(page.getByText(/Evidence ledger \/ Relay/)).toBeVisible();
  await page.getByText(/^Inspect .* evidence records$/).click();
  await entry.getByRole('button', { name: 'Reset evidence' }).click();
  await expect(entry).toContainText('every atlas that shares it');
  await entry.getByRole('button', { name: 'Keep evidence' }).click();
  await entry.getByRole('button', { name: 'Reset evidence' }).click();
  await entry.getByRole('button', { name: 'Confirm reset' }).click();
  await expect(entry).toHaveCount(0);
  await expect(archon).toContainText('1 / 6');
  await archon.getByRole('button').click();
  await expect(page.getByText(/Evidence ledger \/ Archon/)).toBeVisible();
  await expect(entry).toHaveCount(0);
});

test('follows OS appearance and keeps a deliberate override across launches', async ({ desktop }) => {
  const { page } = desktop;
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Use light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Use dark theme' }).click();
  const reopened = await desktop.restart();
  await expect(reopened.locator('html')).toHaveAttribute('data-theme', 'dark');
  await reopened.getByRole('button', { name: 'Use light theme' }).click();
  await reopened.emulateMedia({ colorScheme: 'dark' });
  await expect(reopened.locator('html')).toHaveAttribute('data-theme', 'dark');
});
