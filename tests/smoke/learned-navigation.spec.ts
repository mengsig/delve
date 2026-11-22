import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/main/db/connection';
import { addWorkspace } from '../../src/main/db/workspaces';
import { upsertConcept } from '../../src/main/db/concepts';
import { recordEvidence } from '../../src/main/db/evidence';
import { test } from './desktop';

function seedLearned(directory: string) {
  const db = openDatabase(join(directory, 'delve.sqlite'));
  const workspace = addWorkspace(db, { kind: 'topic', title: 'Navigation fixture' });
  const other = addWorkspace(db, { kind: 'topic', title: 'Another fixture' });
  for (let index = 0; index < 40; index += 1) {
    const title = `Learned concept ${String(index).padStart(2, '0')}`;
    const concept = upsertConcept(db, { key: `navigation-${index}`, title, portable: true, workspaceId: workspace.id });
    upsertConcept(db, { key: `navigation-${index}`, title, portable: true, workspaceId: other.id });
    recordEvidence(db, { conceptId: concept.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true, workspaceId: workspace.id });
  }
  db.close();
}

async function verifyPositionAcrossFilters(page: Page, lastTitle: string) {
  await page.getByLabel('Group by workspace').check();
  await expect(page.getByRole('button', { name: `Open lesson: ${lastTitle}` }).last()).toBeInViewport();
  await page.getByLabel('Group by workspace').uncheck();
  await expect(page.getByRole('button', { name: `Open lesson: ${lastTitle}` })).toBeInViewport();
  await page.getByRole('button', { name: 'Find a concept' }).click();
  const search = page.getByRole('searchbox', { name: 'Search' });
  await search.fill(lastTitle);
  await expect(page.locator('.knowledge-list-select')).toHaveCount(1);
  const otherTitle = lastTitle === 'Learned concept 00' ? 'Learned concept 01' : 'Learned concept 00';
  await search.fill(otherTitle);
  await expect(page.locator('.knowledge-list-select')).toContainText(otherTitle);
  await search.clear();
  await expect(page.getByRole('button', { name: `Open lesson: ${lastTitle}` })).toBeInViewport();
}

test('navigates the virtualized learned list by keyboard', async ({ desktop: { page, directory, application } }) => {
  seedLearned(directory);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'Learned list' }).click();
  const rows = page.locator('.knowledge-list-row');
  await expect(rows).toHaveCount(15);
  const first = rows.nth(0);
  const second = rows.nth(1);
  await page.getByLabel('Group by workspace').focus();
  await page.keyboard.press('Tab');
  await expect(first.locator('.knowledge-list-select')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first.getByRole('button', { name: /Open lesson:/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(second.locator('.knowledge-list-select')).toBeFocused();
  const initialTitle = await second.locator('strong').innerText();
  if (process.env.DELVE_NIGHT_EVIDENCE === '1') {
    mkdirSync('.archon/evidence', { recursive: true });
    await page.screenshot({ path: '.archon/evidence/learned-navigation-after.png' });
  }
  await page.keyboard.press('End');
  const selected = page.locator('.knowledge-list-select:focus');
  await expect(selected).toContainText('Learned concept');
  const lastTitle = await selected.locator('strong').innerText();
  expect(lastTitle).not.toBe(initialTitle);
  expect(await rows.count()).toBeLessThanOrEqual(15);
  await expect(selected).toBeInViewport();
  await expect(selected).toHaveCSS('outline-style', 'solid');
  if (process.env.DELVE_NIGHT_EVIDENCE === '1') await page.screenshot({ path: '.archon/evidence/learned-navigation-end.png' });
  await page.keyboard.press('ArrowUp');
  await expect(selected).not.toContainText(lastTitle);
  await page.keyboard.press('ArrowDown');
  await expect(selected).toContainText(lastTitle);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: `Open lesson: ${lastTitle}` })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(first.getByRole('button', { name: /Open lesson:/ })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('button', { name: `Open lesson: ${lastTitle}` })).toBeFocused();
  await verifyPositionAcrossFilters(page, lastTitle);
  await page.getByRole('button', { name: `Open lesson: ${lastTitle}` }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(selected).toContainText(lastTitle);
  await page.keyboard.press('Enter');
  await expect(page.locator('.knowledge-detail')).toContainText(lastTitle);
  await page.getByRole('button', { name: `Open lesson: ${lastTitle}` }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: lastTitle, level: 1 })).toBeVisible();
});
