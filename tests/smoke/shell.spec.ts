import { expect } from '@playwright/test';
import { test } from './desktop';

test('keeps the shell inset and document scrolling usable in both themes', async ({ desktop: { page, application } }) => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
  await expect(page.locator('.react-flow__node')).toHaveCount(6);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.locator('.shell').evaluate(element => element.getBoundingClientRect().top)).toBe(12);
    expect(await page.evaluate(() => innerWidth - document.documentElement.clientWidth)).toBe(0);
    if (process.env.SHELL_CAPTURE) await page.screenshot({ path: `.archon/evidence/${process.env.SHELL_CAPTURE}-${theme}.png` });
  }
  await page.mouse.move(1250, 400);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await page.keyboard.press('Home');
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.keyboard.press('End');
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  for (const name of ['Terrain', 'Ledger']) {
    const control = page.getByRole('button', { name, exact: true });
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
    await control.click();
    await expect(control).toHaveAttribute('aria-pressed', 'true');
  }
});
