import { expect } from '@playwright/test';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from './desktop';

test.use({ tutorCli: true });

test('previews a real topic request, cancels it, then teaches and assesses through the installed CLI interface', async ({ desktop }) => {
  test.setTimeout(25_000);
  const { page, directory } = desktop;
  const responseFile = join(directory, 'reply.json');
  const receipt = join(directory, 'request.json');
  const gate = join(directory, 'gate');
  const explanation = { type: 'prose', heading: 'A narrower route', text: 'Compare the prefix lengths of routes that match the destination.' };
  const check = { type: 'check', kind: 'short-answer', prompt: 'Why is a /24 preferred to a matching /16?', expected: ['The prefix is longer.'] };
  const envelope = { observation: null, assessment: null, recommendation: null };
  writeFileSync(responseFile, JSON.stringify({ ...envelope, lesson: { schema: 'delve.lesson/1', source: null, blocks: [explanation, check] } }));
  writeFileSync(gate, '');
  await page.getByRole('button', { name: '+ Add', exact: true }).click();
  await page.getByRole('button', { name: 'Any topic', exact: true }).click();
  await page.getByLabel('Any topic', { exact: true }).fill('IP routing');
  await page.getByRole('button', { name: 'Add to atlas →' }).click();
  await page.getByRole('button', { name: 'Start a topic lesson →' }).click();
  await page.getByRole('button', { name: 'Start lesson', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Review what will be sent' });
  const prompt = await preview.locator('pre').innerText();
  expect(prompt).toContain('IP routing');
  expect(prompt).toContain('"depth": "medium"');
  await expect(preview).toContainText(Buffer.byteLength(prompt).toLocaleString('en-US') + ' bytes');
  await expect(preview).toContainText('No files attached');
  expect(existsSync(receipt)).toBe(false);
  await preview.getByRole('button', { name: 'Allow and continue' }).click();
  await expect.poll(() => existsSync(receipt), { timeout: 3500 }).toBe(true);
  expect(JSON.parse(readFileSync(receipt, 'utf8')).stdin).toBe(prompt);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cancelled');
  unlinkSync(gate);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await preview.getByRole('button', { name: 'Allow and continue' }).click();
  await expect(page.getByRole('heading', { name: explanation.heading })).toBeVisible();
  writeFileSync(responseFile, JSON.stringify({ assessment: true, observation: 'You recognized prefix specificity.',
    recommendation: { action: 'Compare overlapping routes', reason: 'You can identify the narrower match.', targetId: null },
    lesson: { schema: 'delve.lesson/1', source: null, blocks: [{ type: 'trace', steps: ['Match destination', 'Compare lengths', 'Choose /24'] }] } }));
  await page.getByRole('textbox', { name: check.prompt }).fill('It covers a smaller destination network.');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('log')).toContainText('You recognized prefix specificity.');
  await expect(page.getByRole('log')).toContainText('Choose /24');
  await expect(page.getByRole('complementary')).toContainText('Prior knowledge');
});
