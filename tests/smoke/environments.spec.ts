import { expect, type Page } from '@playwright/test';
import { test } from './desktop';

async function ledger(page: Page, concept: string) {
  await page.getByRole('navigation').getByRole('button', { name: 'Progress' }).click();
  await page.getByText(/^Inspect .* learning records$/).click();
  return page.getByRole('listitem').filter({ hasText: concept }).filter({ hasText: 'environment' });
}

test('records a dispatch decision for practice without advancing the lesson', async ({ desktop: { page } }) => {
  await page.getByRole('button', { name: 'Open lesson →' }).click();
  const lab = page.frameLocator('.instrument-frame');
  for (let tick = 1; tick <= 3; tick++) {
    await lab.getByRole('button', { name: 'Advance one tick →' }).click();
    await expect(lab.getByRole('status')).toContainText(`Clock ${tick}/3`);
  }
  await lab.getByRole('button', { name: 'Accept A’s write' }).click();
  await expect(page.getByRole('log')).toContainText('You accepted generation 7 while generation 8 was active.');
  await expect(page.getByRole('button', { name: /Next lesson:/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask tutor', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask the demo tutor' }).fill('What should I practice next?');
  await page.getByRole('button', { name: 'Ask question' }).click();
  await expect(page.getByRole('log').getByRole('heading', { name: 'From your last run' })).toBeVisible();
  await expect(page.getByRole('log').frameLocator('.instrument-frame').getByRole('button', { name: 'Advance one tick →' })).toBeVisible();
  await page.getByRole('button', { name: '← Back to atlas' }).click();
  await expect(page.getByRole('complementary', { name: 'Field guide' })).toContainText('Accepting the stale result');
  const record = await ledger(page, 'Worker leases');
  await expect(record).toContainText('medium · partial');
  await expect(record).toContainText('You accepted generation 7');
});

test('revises exposure evidence when the learner compensates for a fast shutter', async ({ desktop }) => {
  const { page } = desktop;
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  await page.getByRole('combobox').fill('Photography');
  await page.getByRole('combobox').press('Enter');
  await page.getByRole('button', { name: 'Open lesson →' }).click();
  const lab = page.frameLocator('.instrument-frame');
  await lab.getByRole('combobox', { name: 'Shutter speed' }).selectOption('500');
  await expect(lab.getByRole('combobox', { name: 'Shutter speed' })).toHaveValue('500');
  await lab.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByRole('log')).toContainText('sharp but underexposed');
  await lab.getByRole('combobox', { name: 'ISO' }).selectOption('800');
  await expect(lab.getByRole('combobox', { name: 'ISO' })).toHaveValue('800');
  await lab.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByRole('log')).toContainText('Captured at 1/500 s and ISO 800.');
  const record = await ledger(await desktop.restart(), 'Moving subjects');
  await expect(record).toContainText('medium · partial');
  await expect(record).toContainText('Captured at 1/500 s and ISO 800.');
});

test('isolates the instrument document and blocks access to desktop resources', async ({ desktop: { page } }) => {
  await page.getByRole('button', { name: 'Open lesson →' }).click();
  const lab = page.frameLocator('.instrument-frame');
  await expect(lab.getByRole('button', { name: 'Advance one tick →' })).toBeVisible();
  const boundary = await lab.locator('main').evaluate(async () => {
    function denied(read: () => unknown) {
      try { read(); return false; } catch (error) { return error instanceof DOMException && error.name === 'SecurityError'; }
    }
    let fetchDenied = false;
    try { await fetch('app://delve/index.html'); } catch (error) { fetchDenied = error instanceof TypeError; }
    const browser = globalThis as typeof globalThis & { origin: string; parent: { document: unknown };
      navigator: { permissions: { query(descriptor: { name: string }): Promise<{ state: string }> } } };
    return { origin: browser.origin, parent: denied(() => browser.parent.document), storage: denied(() => localStorage.length),
      node: 'require' in browser || 'process' in browser, ipc: 'delve' in browser, fetchDenied,
      locationPermission: (await browser.navigator.permissions.query({ name: 'geolocation' })).state };
  });
  expect(boundary).toEqual({ origin: 'null', parent: true, storage: true, node: false, ipc: false,
    fetchDenied: true, locationPermission: 'denied' });
  await lab.locator('main').evaluate(() => {
    (globalThis as typeof globalThis & { location: { assign: (url: string) => void } }).location.assign('about:blank');
  });
  await expect(page.locator('#instrument')).toContainText('The instrument document changed.', { timeout: 3000 });
  await expect(page.locator('iframe')).toHaveCount(0);
});
