import { expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/main/db/connection';
import { addWorkspace } from '../../src/main/db/workspaces';
import { addPrerequisite, upsertConcept } from '../../src/main/db/concepts';
import { recordEvidence } from '../../src/main/db/evidence';
import { createTransferLink } from '../../src/main/db/knowledge';
import { test, shortcut } from './desktop';
import { withinBudget } from './action-budget';

test.use({ tutorCli: true });

function seedKnowledge(directory: string) {
  const db = openDatabase(join(directory, 'delve.sqlite'));
  const first = addWorkspace(db, { kind: 'topic', title: 'Distributed systems' });
  const second = addWorkspace(db, { kind: 'topic', title: 'Reliable services' });
  const repo = addWorkspace(db, { kind: 'git', path: join(directory, 'service-repo') });
  const shared = upsertConcept(db, { key: 'knowledge-smoke-queues', title: 'Queues and workers', summary: 'Queues connect producers and workers.', portable: true, workspaceId: first.id });
  upsertConcept(db, { key: 'knowledge-smoke-queues', title: 'Queues and workers', portable: true, workspaceId: second.id });
  upsertConcept(db, { key: 'knowledge-smoke-queues', title: 'Queues and workers', portable: true, workspaceId: repo.id });
  const retry = upsertConcept(db, { key: 'knowledge-smoke-retries', title: 'Retry strategies', summary: 'Retry safely.', portable: true, workspaceId: repo.id });
  const backpressure = upsertConcept(db, { key: 'knowledge-smoke-backpressure', title: 'Backpressure', summary: 'Control demand.', portable: true, workspaceId: second.id });
  addPrerequisite(db, retry.id, shared.id);
  recordEvidence(db, { conceptId: shared.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true, workspaceId: first.id });
  createTransferLink(db, { fromConceptId: shared.id, toConceptId: retry.id, provider: 'codex', model: 'fixture', reason: 'Both manage work across failures.' });
  db.close();
  return { shared, backpressure };
}

async function verifyConnections(page: Page, directory: string, sharedId: number, backpressureId: number) {
  await page.locator('.knowledge-detail').getByLabel('Provider').selectOption('codex');
  await page.getByRole('button', { name: 'Preview request' }).click();
  const preview = page.getByRole('dialog', { name: 'Review what will be sent' });
  await expect(preview).toContainText('Queues and workers');
  expect(existsSync(join(directory, 'request.json'))).toBe(false);
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ suggestions: [{ fromConceptId: sharedId, toConceptId: backpressureId, reason: 'Both regulate work.' }] }));
  await preview.getByRole('button', { name: 'Allow once and find connections' }).click();
  await expect(page.locator('.knowledge-detail')).toContainText('Both regulate work.');
  await page.locator('.knowledge-detail li').filter({ hasText: 'Both regulate work.' }).getByRole('button', { name: 'Remove link' }).click();
  await expect(page.locator('.knowledge-detail')).not.toContainText('Both regulate work.');
}

async function captureThemes(page: Page, name: string) {
  mkdirSync('.archon/evidence', { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.screenshot({ path: `.archon/evidence/${name}-${theme}.png` });
  }
}

async function verifyLearnedLessonActions(page: Page) {
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'Everything I’ve learned' }).click();
  const openLesson = page.getByRole('button', { name: 'Open lesson: Queues and workers' }).first();
  await openLesson.focus();
  await withinBudget(page, 'Open a learned concept lesson by keyboard', 1, async () => {
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Queues and workers', level: 1 })).toBeVisible();
  });
  await page.keyboard.press(shortcut);
  await page.getByRole('combobox', { name: /search/i }).fill('Knowledge');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Knowledge.' })).toBeVisible();
  await expect(page.getByLabel('State')).toHaveValue('verified');
  await page.getByRole('button', { name: 'Everything I’ve learned' }).click();
  await withinBudget(page, 'Open a learned concept lesson by pointer', 1, async () => {
    await page.getByRole('button', { name: 'Open lesson: Queues and workers' }).first().click();
    await expect(page.getByRole('heading', { name: 'Queues and workers', level: 1 })).toBeVisible();
  });
}

test('opens the global graph, finds a shared learned concept and opens its lesson', async ({ desktop: { page, application, directory } }) => {
  const { shared, backpressure } = seedKnowledge(directory);
  await page.setViewportSize({ width: 1440, height: 900 });
  await captureThemes(page, 'readme-after');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await page.setViewportSize({ width: 1280, height: 771 });
  await withinBudget(page, 'Open Knowledge from the header', 1, async () => {
    await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Knowledge.' })).toBeVisible();
  });
  await expect(page.getByText(/shared$/)).toBeVisible();
  await page.getByLabel('State').selectOption('verified');
  await page.getByLabel('Search', { exact: true }).fill('Queues and workers');
  await page.getByRole('button', { name: 'Queues and workers', exact: true }).click();
  for (const name of ['Distributed systems', 'Reliable services', 'service-repo']) await expect(page.locator('.knowledge-detail')).toContainText(name);
  await expect(page.locator('.knowledge-detail')).toContainText('Both manage work across failures.');
  await page.getByRole('button', { name: 'Focus neighbourhood' }).click();
  await expect(page.getByRole('button', { name: 'Show all connections' })).toBeVisible();
  await page.getByLabel('Search', { exact: true }).clear();
  await page.getByLabel('State').selectOption('');
  await expect.poll(() => page.locator('.knowledge-map canvas').evaluate(canvas => {
    const element = canvas as HTMLCanvasElement;
    const context = element.getContext('2d');
    if (!context) return false;
    return context.getImageData(0, 0, element.width, element.height).data.some((value, index) => index % 4 === 3 && value > 0);
  })).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await captureThemes(page, 'knowledge');
  await page.getByRole('button', { name: 'Everything I’ve learned' }).click();
  await expect(page.locator('.knowledge-list')).toContainText('Transfers: Retry strategies');
  await captureThemes(page, 'learned-after');
  await page.getByLabel('Group by workspace').check();
  await expect(page.locator('.knowledge-list-select').filter({ hasText: 'Queues and workers' })).toHaveCount(3);
  await page.locator('.knowledge-list-select').filter({ hasText: 'Queues and workers' }).first().click();
  await expect(page.locator('.knowledge-detail')).toContainText('Queues and workers');
  await page.getByRole('button', { name: 'Show graph' }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 640));
  await page.setViewportSize({ width: 960, height: 611 });
  await expect(page.getByRole('searchbox', { name: 'Search' })).toBeVisible();
  for (const name of ['Workspace', 'State', 'Depth']) await expect(page.getByRole('combobox', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open lesson', exact: true })).toBeVisible();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await page.setViewportSize({ width: 1280, height: 771 });
  await verifyConnections(page, directory, shared.id, backpressure.id);
  await page.getByLabel('State').selectOption('verified');
  await withinBudget(page, 'Open a review of the selected concept', 1, async () => {
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Review what will be sent' })).toBeVisible();
  });
  await page.getByRole('button', { name: 'Close preview' }).click();
  await verifyLearnedLessonActions(page);
});
