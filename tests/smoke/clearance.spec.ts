/// <reference lib="dom" />
import { expect, type Page } from '@playwright/test';
import { test } from './desktop';

async function checkClearance(page: Page, name: string) {
  const instrument = page.locator('.instrument-frame');
  const button = page.frameLocator('.instrument-frame').getByRole('button', { name: 'Advance one tick →' });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport({ ratio: 1 });
  await expect.poll(() => page.locator('.reader-scroll').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(async () => instrument.evaluate(frame => {
    const box = frame.closest('.reader-scroll')!.getBoundingClientRect();
    const composer = document.querySelector('.reader-composer')!.getBoundingClientRect();
    return composer.top - box.bottom;
  })).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => page.frameLocator('.instrument-frame').locator('main').evaluate(main =>
    document.body.getBoundingClientRect().height <= window.innerHeight && main.getBoundingClientRect().bottom <= window.innerHeight,
  )).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.DELVE_CLEARANCE_EVIDENCE) {
    await page.screenshot({ path: `.archon/evidence/after-${name}.png` });
  }
  const composer = page.getByRole('textbox', { name: 'Ask the demo tutor' });
  await composer.scrollIntoViewIfNeeded();
  await expect(composer).toBeInViewport({ ratio: 1 });
}

test('keeps lesson instruments clear at supported window sizes', async ({ desktop: { page, application } }) => {
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getMinimumSize())).toEqual([960, 640]);
  await page.getByRole('button', { name: 'Open lesson →' }).click();
  await page.getByRole('button', { name: 'Ask tutor', exact: true }).click();
  await expect(page.frameLocator('.instrument-frame').getByRole('button', { name: 'Advance one tick →' })).toBeVisible();
  for (const [name, width, height] of [['minimum', 960, 640], ['1280', 1280, 720], ['default', 1200, 800]] as const) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height), { width, height });
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize())).toEqual([width, height]);
    await checkClearance(page, name);
  }
  await page.frameLocator('.instrument-frame').getByRole('button', { name: 'Advance one tick →' }).click();
  await expect(page.frameLocator('.instrument-frame').getByRole('status')).toContainText('Clock 1/3');
});
