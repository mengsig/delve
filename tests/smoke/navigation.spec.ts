/// <reference lib="dom" />
import { expect, type Page } from '@playwright/test';
import { shortcut, test } from './desktop';
import { withinBudget } from './action-budget';

const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });

test('opens primary destinations and switches workspace in one action', async ({ desktop: { page } }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [screen, heading] of [['Changes', 'Reject late worker results.'], ['Progress', 'Your field record.'], ['Atlas', 'Repository atlas.']] as const) {
    await withinBudget(page, 'Open ' + screen, 1, async () => {
      await button(page, screen).click();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    });
  }
  const workspace = button(page, 'Photography (demo)');
  await withinBudget(page, 'Switch workspace directly from Atlas', 1, async () => {
    await expect(workspace).toBeInViewport({ ratio: 1 });
    await workspace.click();
    await expect(page.getByRole('heading', { name: 'Topic atlas.' })).toBeVisible();
  });
  const guide = page.getByRole('complementary', { name: 'Field guide' });
  await expect(guide.getByRole('button').first()).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 3840, height: 2160 });
  await expect(guide.getByRole('button').first()).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('continues a lesson, environment or change in one click after a restart', async ({ desktop }) => {
  let page = desktop.page;
  await button(page, 'Open lesson →').click();
  const lesson = (p: Page) => p.getByRole('heading', { name: 'Worker leases', exact: true });
  await expect(lesson(page)).toBeVisible();
  page = await desktop.restart();
  await withinBudget(page, 'Continue the last lesson', 1, async () => {
    const resume = button(page, /Continue lesson Worker leases/);
    await expect(resume).toBeInViewport({ ratio: 1 });
    await resume.click();
    await expect(lesson(page)).toBeVisible();
  });
  const bench = page.frameLocator('.instrument-frame');
  await bench.getByRole('button', { name: 'Advance one tick →' }).click();
  await expect(bench.getByRole('status')).toContainText('Clock 1/3');
  await button(page, 'Atlas').click();
  await button(page, 'Photography (demo)').click();
  await expect(page.getByRole('heading', { name: 'Topic atlas.' })).toBeVisible();
  page = await desktop.restart();
  await withinBudget(page, 'Continue the exact environment across workspaces', 1, async () => {
    await button(page, /Continue environment The handoff bench/).click();
    await expect(page.locator('#instrument')).toBeFocused();
    await expect(page.frameLocator('.instrument-frame').getByRole('button', { name: 'Advance one tick →' })).toBeInViewport();
  });
  await button(page, 'Changes').click();
  await expect(page.getByRole('heading', { name: 'Reject late worker results.' })).toBeVisible();
  page = await desktop.restart();
  await withinBudget(page, 'Continue the last change', 1, async () => {
    await button(page, /Continue change Reject late worker results/).click();
    await expect(page.getByRole('heading', { name: 'Reject late worker results.' })).toBeVisible();
  });
});

test('finds views, workspaces and recent lessons in the keyboard palette', async ({ desktop: { page } }) => {
  await button(page, 'Open lesson →').click();
  await expect(page.getByRole('heading', { name: 'Worker leases' })).toBeVisible();
  await button(page, '+ Add').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Worker leases' })).toBeVisible();
  await button(page, 'Atlas').click();
  const finder = page.getByRole('combobox', { name: 'Search workspaces, views and lessons' });
  await withinBudget(page, 'Open the command palette with one shortcut', 1, async () => {
    await page.keyboard.press(shortcut);
    await expect(finder).toBeFocused();
  });
  for (const name of ['Atlas View', 'Progress View', 'Changes View', 'Terrain map Atlas view', 'Folio ledger Atlas view']) {
    await expect(page.getByRole('option', { name, exact: true })).toBeVisible();
  }
  await finder.fill('relay');
  await finder.press('Enter');
  await expect(page.locator('.topline')).toContainText('Relay');
  await page.keyboard.press(shortcut);
  await finder.fill('worker lesson');
  await expect(page.getByRole('option', { selected: true })).toContainText('Worker leases');
  await finder.press('Enter');
  await expect(page.getByRole('heading', { name: 'Worker leases', exact: true })).toBeVisible();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.getByRole('heading', { name: 'Repository atlas.' })).toBeVisible();
});
