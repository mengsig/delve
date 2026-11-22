import { expect, type Page } from '@playwright/test';
import { test } from './desktop';

async function checkDocumentScroll(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollHeight: document.documentElement.scrollHeight }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.height);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.mouse.move(dimensions.width - 4, 80);
    if (process.env.SHELL_CAPTURE) await page.screenshot({ path: `.archon/evidence/${process.env.SHELL_CAPTURE}-${name}-${theme}.png` });
    await page.mouse.down();
    await page.mouse.move(dimensions.width - 4, dimensions.height * .7, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  }
}

test('keeps the shell inset and document scrolling usable in both themes', async ({ desktop: { page, application } }) => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
  await expect(page.locator('.react-flow__node')).toHaveCount(6);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.locator('.shell').evaluate(element => element.getBoundingClientRect().top)).toBe(12);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement, '::-webkit-scrollbar').width)).toBe('8px');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement, '::-webkit-scrollbar-track').backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    if (process.env.SHELL_CAPTURE) await page.screenshot({ path: `.archon/evidence/${process.env.SHELL_CAPTURE}-${theme}.png` });
  }
  await page.mouse.move(1250, 400);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await page.keyboard.press('Home');
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.keyboard.press('End');
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await page.keyboard.press('Home');
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  for (const key of ['ArrowDown', 'PageDown']) {
    await page.keyboard.press(key);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await page.keyboard.press('Home');
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  }
  const rightEdge = await page.evaluate(() => innerWidth - 4);
  await page.mouse.move(rightEdge, 80);
  await page.mouse.down();
  await page.mouse.move(rightEdge, 500, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  for (const name of ['Terrain', 'Ledger']) {
    const control = page.getByRole('button', { name, exact: true });
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
    await control.click();
    await expect(control).toHaveAttribute('aria-pressed', 'true');
  }
  await checkDocumentScroll(page, 'folio');
  await page.getByRole('button', { name: 'Open lesson →' }).click();
  await expect(page.getByRole('heading', { name: 'Worker leases', exact: true })).toBeVisible();
  await checkDocumentScroll(page, 'lesson');
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reject late worker results.' })).toBeVisible();
  await checkDocumentScroll(page, 'change');
});
