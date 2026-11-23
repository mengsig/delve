import { expect, type Page } from '@playwright/test';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from './desktop';

test.use({ tutorCli: true });

const check = { type: 'check', kind: 'prediction', prompt: 'Which route wins?',
  options: ['The /16', 'The /24', 'Neither', 'Both'], expected: 1 };
const envelope = { observation: null, assessment: null, recommendation: null };

function opening(directory: string) {
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ ...envelope,
    lesson: { schema: 'delve.lesson/1', source: null, blocks: [
      { type: 'prose', heading: 'Routing', text: 'Compare matching routes. '.repeat(60) }, check,
    ] } }));
}

function reply(directory: string) {
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ ...envelope, assessment: false,
    observation: 'That route is less specific.', reasoningFeedback: 'The longer prefix wins.',
    lesson: { schema: 'delve.lesson/1', source: null, blocks: [{ type: 'prose', heading: 'Prefix length', text: 'A longer prefix matches a smaller range.' },
      { ...check, prompt: 'Which of these matching routes is more specific?', options: ['The /8', 'The /20', 'The /12', 'The /4'] }] } }));
}

async function startLesson(page: Page, directory: string, width: number, height: number) {
  opening(directory);
  await page.setViewportSize({ width, height });
  await page.getByRole('button', { name: 'Add a workspace', exact: true }).click();
  await page.getByRole('textbox', { name: 'Topic or repository' }).fill('Routing');
  await page.getByRole('button', { name: 'Allow once and start lesson' }).click();
  await expect(page.getByRole('heading', { name: 'Which route wins?' })).toBeVisible();
  reply(directory);
}

async function answer(page: Page) {
  await page.getByRole('button', { name: 'The /16', exact: true }).click();
  await page.getByRole('textbox', { name: /Explain your reasoning/ }).fill('It is the broader route.');
  await page.getByRole('button', { name: 'Check answer' }).click();
  await page.getByRole('region', { name: 'Review what will be sent' })
    .getByRole('button', { name: 'Always allow for this workspace' }).click();
}

for (const size of [{ width: 1276, height: 666 }, { width: 1280, height: 720 }]) {
  const dimensions = `${size.width}x${size.height}`;
  test(`follows answer feedback at ${dimensions}`, async ({ desktop: { page, directory } }, info) => {
    await startLesson(page, directory, size.width, size.height);
    await answer(page);
    await expect(page.getByText('That route is less specific.')).toBeInViewport();
    await expect(page.getByText('The longer prefix wins.')).toBeInViewport();
    await expect(page.getByRole('button', { name: 'New reply' })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`s4-${dimensions}.png`) });
    const transcript = page.getByLabel('Lesson transcript');
    await transcript.evaluate(node => {
      const extra = document.createElement('div');
      extra.style.height = '200px';
      node.firstElementChild!.append(extra);
      node.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(() => transcript.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
  });
}

test('preserves a reader position until New reply is selected', async ({ desktop: { page, directory } }) => {
  await startLesson(page, directory, 1276, 666);
  const gate = join(directory, 'gate');
  writeFileSync(gate, '');
  await answer(page);
  const transcript = page.getByLabel('Lesson transcript');
  await transcript.evaluate(node => { node.scrollTop = 30; });
  await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBe(30);
  unlinkSync(gate);
  await expect(page.getByText('That route is less specific.')).toBeAttached();
  await expect(transcript).toHaveJSProperty('scrollTop', 30);
  await page.getByRole('button', { name: 'New reply' }).click();
  await expect(page.getByText('The longer prefix wins.')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'New reply' })).toHaveCount(0);
});
