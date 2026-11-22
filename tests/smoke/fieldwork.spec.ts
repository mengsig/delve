/// <reference lib="dom" />
import { expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { openDatabase } from '../../src/main/db/connection';
import { upsertConcept, addPrerequisite } from '../../src/main/db/concepts';
import { listWorkspaces } from '../../src/main/db/workspaces';
import { test } from './desktop';
import { withinBudget } from './action-budget';

const check = (page: Page) => page.getByRole('button', { name: 'Check answer' });
const reason = (page: Page) => page.getByRole('textbox', { name: /Explain your reasoning/ });
const open = (page: Page) => page.getByRole('button', { name: 'Open lesson →' });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Lesson progress' });

for (const explain of [false, true]) {
  test('opens a ready lesson and checks it in ' + (explain ? 'four clicks with reasoning' : 'three clicks'), async ({ desktop: { page } }) => {
    await withinBudget(page, 'Open lesson through first submission', explain ? 4 : 3, async () => {
      await open(page).click();
      await page.getByRole('button', { name: 'The current lease holder’s', exact: true }).click();
      if (explain) {
        await reason(page).click();
        await page.keyboard.insertText('B still holds the current lease.');
      }
      await check(page).click();
      await expect(page.getByRole('log')).toContainText('✓ Correct check');
    });
    await expect(rail(page).getByRole('meter', { name: 'Worker leases' })).toHaveJSProperty('value', 1);
    await expect(page.getByRole('meter', { name: /Workspace mastery/ })).toHaveJSProperty('value', 2);
    await page.getByRole('button', { name: 'Progress at medium depth' }).click();
    await expect(page.getByRole('meter', { name: 'Worker leases' })).toHaveJSProperty('value', 1);
    await page.getByLabel('Reading depth').selectOption('low');
    await expect(page.getByRole('meter', { name: 'Worker leases' })).toHaveJSProperty('value', 0);
  });
}

test('switches choices by keyboard and restores scoped drafts and transcript position', async ({ desktop: { page } }) => {
  await page.setViewportSize({ width: 960, height: 611 });
  // Exercise the hotkey as soon as the choices are interactive.
  const firstKey = await page.evaluateHandle(() => {
    const result = { handled: false };
    const observer = new MutationObserver(() => {
      const option = document.querySelectorAll<HTMLButtonElement>('.answer-options button')[3];
      if (!option || option.disabled) return;
      observer.disconnect();
      result.handled = !option.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true, cancelable: true }));
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    return result;
  });
  await open(page).click();
  const options = page.locator('.answer-options button');
  await expect(options.nth(3)).toBeEnabled();
  expect(await firstKey.evaluate(result => result.handled)).toBe(true);
  await firstKey.dispose();
  await expect(options.nth(3)).toHaveAttribute('aria-pressed', 'true');
  for (const key of ['1', '4', '3', '2']) {
    await page.keyboard.press(key);
    await expect(options.nth(Number(key) - 1)).toHaveAttribute('aria-pressed', 'true');
  }
  await reason(page).focus();
  await page.keyboard.type('Claim 42 still holds.');
  await expect(reason(page)).toHaveValue('Claim 42 still holds.');
  await expect(options.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await options.first().dispatchEvent('keydown', { key: '3', isComposing: true });
  await expect(options.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Ask tutor', exact: true }).click();
  const question = page.getByRole('textbox', { name: 'Ask the demo tutor' });
  await question.fill('Show me the sequence.');
  await page.getByRole('button', { name: 'Answer check' }).click();
  const transcript = page.locator('.reader-scroll');
  await transcript.evaluate(node => { node.scrollTop = 160; });
  await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBe(160);
  await expect(check(page)).toBeInViewport({ ratio: 1 });
  await expect(rail(page)).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(611);
  await page.getByRole('button', { name: '← Back to atlas' }).click();
  await open(page).click();
  await expect(reason(page)).toHaveValue('Claim 42 still holds.');
  await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBe(160);
  await page.getByRole('button', { name: 'Ask tutor', exact: true }).click();
  await expect(question).toHaveValue('Show me the sequence.');
  await page.getByRole('button', { name: 'Answer check' }).click();
  await reason(page).press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await expect(page.getByRole('log')).toContainText('Claim 42 still holds.');
  await expect(page.getByRole('button', { name: 'New reply' })).toBeVisible();
  await page.getByRole('button', { name: 'New reply' }).click();
  await expect.poll(() => transcript.evaluate(n => n.scrollHeight - n.scrollTop - n.clientHeight)).toBeLessThan(2);
  await expect(reason(page)).toBeEmpty();
});

test('scrolls a long plan independently and keeps the active concept and overall meter in view', async ({ desktop }) => {
  const db = openDatabase(join(desktop.directory, 'delve.sqlite'));
  try {
    const workspaceId = listWorkspaces(db).activeId!;
    const current = db.prepare("SELECT c.id FROM workspace_concepts m JOIN concepts c ON c.id=m.concept_id WHERE m.workspace_id=? AND c.title=?").get(workspaceId, 'Worker leases');
    expect(current).toBeDefined();
    for (let index = 1; index <= 32; index++) {
      const concept = upsertConcept(db, { workspaceId, key: 'practice-' + index, title: 'Practice ' + index, portable: false });
      addPrerequisite(db, concept.id, Number(current!.id));
    }
  } finally { db.close(); }
  const page = await desktop.restart();
  await page.setViewportSize({ width: 960, height: 611 });
  await open(page).click();
  const plan = page.getByRole('list', { name: 'Concept mastery' });
  const active = plan.getByRole('meter', { name: 'Worker leases' });
  await expect(plan.getByRole('listitem')).toHaveCount(38);
  for (const bottom of [true, false]) {
    await plan.evaluate((node, down) => { node.scrollTop = down ? node.scrollHeight : 0; }, bottom);
    await expect(active).toBeInViewport({ ratio: 1 });
    await expect(check(page)).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('meter', { name: /Workspace mastery/ })).toHaveJSProperty('max', 38);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(611);
  }
});
