import { expect } from '@playwright/test';
import { test } from './desktop';

test('keeps Atlas controls in the default viewport and reachable at minimum size', async ({ desktop }) => {
  const { page } = desktop;
  await page.setViewportSize({ width: 1280, height: 800 });
  const controls = [
    page.getByRole('button', { name: 'Atlas', exact: true }),
    page.getByRole('group', { name: 'Your workspaces' }),
    page.getByRole('group', { name: 'Map controls' }),
    page.getByRole('button', { name: 'Open lesson →' }),
    page.getByLabel('Field guide').getByRole('button').first(),
    page.getByRole('button', { name: 'Terrain', exact: true }),
    page.getByRole('button', { name: 'Ledger', exact: true }),
  ];
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
    expect(box!.y + box!.height).toBeLessThanOrEqual(800);
  }
  await page.setViewportSize({ width: 960, height: 640 });
  for (const control of controls) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  await page.getByRole('button', { name: 'Ledger', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ledger', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
