import { expect } from '@playwright/test';
import { test } from './desktop';

for (const [workspace, marker, label] of [
  ['Archon', 'Write fencing', 'Event journal'],
  ['Relay', 'Retry policy', 'Event journal'],
  ['Photography', 'Shutter speed', 'Sensor gain'],
] as const) {
  test(`selects ${workspace} Terrain concepts by clicking the marker and label`, async ({ desktop: { page } }) => {
    if (workspace !== 'Archon') {
      await page.getByRole('group', { name: 'Your workspaces' }).getByRole('button', { name: new RegExp(workspace) }).click();
    }
    const terrain = page.getByRole('region', { name: `${workspace} terrain` });
    const inspector = page.getByRole('region', { name: 'Selected concept' }).locator('[aria-live]');
    const markerButton = terrain.getByRole('button', { name: new RegExp(`^${marker},`) });
    const labelButton = terrain.getByRole('button', { name: new RegExp(`^${label},`) });

    await expect(markerButton).toHaveAttribute('aria-pressed', 'false');
    await markerButton.click({ timeout: 5_000 });
    await expect(markerButton).toHaveAttribute('aria-pressed', 'true');
    await expect(inspector).toHaveText(marker);

    await expect(labelButton).toHaveAttribute('aria-pressed', 'false');
    await labelButton.getByText(label, { exact: true }).click({ timeout: 5_000 });
    await expect(labelButton).toHaveAttribute('aria-pressed', 'true');
    await expect(inspector).toHaveText(label);
  });
}

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
  const fit = page.getByRole('button', { name: 'Fit map', exact: true });
  await fit.click();
  await page.keyboard.press('Tab');
  const firstNode = nodes.getByRole('button').first();
  await expect(firstNode).toBeFocused();
  await page.keyboard.press('Space');
  await expect(firstNode).toHaveAttribute('aria-pressed', 'true');
  const journal = nodes.getByRole('button', { name: /^Event journal,/ });
  await journal.focus();
  await page.keyboard.press('Enter');
  await expect(inspector).toContainText('Event journal');
  await expect(nodes.getByRole('button', { name: /Worker leases,.*Recommended next/ })).toHaveClass(/next/);
  await page.getByRole('button', { name: 'Ledger', exact: true }).click();
  const ledger = page.getByRole('region', { name: 'Folio dependency ledger' });
  await expect(ledger).toContainText('Durable queue');
  await expect(ledger).toContainText('Requires');
  await expect(inspector).toContainText('Event journal');
  const queueRow = ledger.getByRole('button', { name: /^Durable queue/ });
  await queueRow.focus();
  await page.keyboard.press('Space');
  await expect(queueRow).toHaveAttribute('aria-pressed', 'true');
  await expect(inspector.locator('[aria-live]')).toHaveText('Durable queue');
  await ledger.getByRole('button', { name: /^Event journal/ }).focus();
  await page.keyboard.press('Enter');
  await inspector.getByRole('button', { name: 'Open lesson →' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Event journal' })).toBeVisible();
  await page.getByRole('button', { name: '← Back to atlas' }).click();
  await expect(inspector).toContainText('Event journal');
});

test('lesson depth, local conversations and linked change concepts work offline', async ({ desktop: { page } }) => {
  await page.getByRole('button', { name: 'Open lesson →' }).click();
  await expect(page.getByRole('heading', { name: 'Worker leases', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Low · Protocol detail' }).click();
  await page.getByText('Text alternative', { exact: true }).click();
  await expect(page.locator('#instrument details')).toContainText('Compare before committing.');
  await expect(page.locator('pre mark')).toBeVisible();
  await page.getByRole('textbox', { name: 'Ask the demo tutor' }).fill('How does the result writer check ownership?');
  await page.getByRole('button', { name: 'Ask question' }).click();
  await expect(page.getByRole('log')).toContainText('How does the result writer check ownership?');
  await expect(page.getByRole('log').getByRole('heading', { name: 'Follow the late result' })).toBeVisible();
  await page.getByRole('button', { name: 'Task ID and worker start time' }).click();
  await expect(page.getByRole('log')).toContainText('partial evidence');
  await expect(page.getByRole('complementary').getByRole('button', { name: 'Open Write fencing →' })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Let’s look at the decision again');
  await page.getByRole('button', { name: 'Task ID and active generation' }).click();
  await expect(page.getByText(/Connection learned\./).first()).toBeVisible();
  await page.getByRole('button', { name: '← Back to atlas' }).click();
  await page.getByRole('button', { name: 'Open lesson →' }).click();
  await expect(page.getByRole('log')).toContainText('How does the result writer check ownership?');
  await page.getByRole('navigation', { name: 'Application' }).getByRole('button', { name: 'Changes' }).click();
  await expect(page.getByRole('heading', { name: 'Reject late worker results.' })).toBeVisible();
  await page.getByRole('button', { name: 'Teach me this change' }).click();
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
