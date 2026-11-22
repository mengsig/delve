import { expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shortcut, test } from './desktop';
import { withinBudget } from './action-budget';

test.use({ tutorCli: true });

const explanation = { type: 'prose', heading: 'A narrower route', text: 'Compare the prefix lengths of routes that match the destination.' };
const check = { type: 'check', kind: 'prediction', prompt: 'Why is a /24 preferred to a matching /16?', options: ['It is newer', 'It covers fewer addresses', 'It uses more hops', 'It ignores the destination'], expected: 1 };
const envelope = { observation: null, assessment: null, recommendation: null };
const add = (page: Page) => page.getByRole('button', { name: 'Add a workspace', exact: true });
const source = (page: Page) => page.getByRole('textbox', { name: 'Topic or repository' });
const start = (page: Page) => page.getByRole('button', { name: 'Allow once and start lesson' });

function writeOpening(directory: string, long = false) {
  const prose = long ? { ...explanation, text: (explanation.text + ' ').repeat(45) } : explanation;
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({
    ...envelope, lesson: { schema: 'delve.lesson/1', source: null, blocks: [prose, check] },
  }));
}

async function typeTopic(page: Page, title: string) {
  await expect(source(page)).toBeFocused();
  await page.keyboard.insertText(title);
  await expect(page.getByText('No files attached', { exact: false })).toBeVisible();
}

test('opens the first block from home in two actions, including first-use consent', async ({ desktop: { page, directory } }) => {
  writeOpening(directory);
  await page.setViewportSize({ width: 1280, height: 800 });
  const receipt = join(directory, 'request.json');
  await withinBudget(page, 'Create a topic and read the first block', 2, async () => {
    await add(page).click();
    await typeTopic(page, 'IP routing');
    await expect(page.getByText('Advanced options', { exact: false })).toBeVisible();
    await expect(page.locator('.setup-advanced')).toHaveJSProperty('open', false);
    await expect(start(page)).toBeInViewport({ ratio: 1 });
    expect(existsSync(receipt)).toBe(false);
    await start(page).click();
    await expect(page.getByRole('heading', { name: explanation.heading })).toBeInViewport();
  });
  const invocation = JSON.parse(readFileSync(receipt, 'utf8'));
  expect(invocation.stdin).toContain('"depth": "medium"');
  expect(invocation.stdin).toContain('IP routing');
  await expect(page.getByRole('dialog', { name: 'Review what will be sent' })).toHaveCount(0);
});

test.describe('first run', () => {
  test.use({ firstRun: true });

  test('keeps the primary topic action visible with advanced controls collapsed', async ({ desktop: { page, directory } }) => {
    writeOpening(directory);
    await page.setViewportSize({ width: 1280, height: 800 });
    await typeTopic(page, 'Routing');
    await expect(page.locator('.setup-advanced')).toHaveJSProperty('open', false);
    await expect(start(page)).toBeInViewport({ ratio: 1 });
    await withinBudget(page, 'Approve workspace tutoring from first run', 1, async () => {
      await page.getByRole('button', { name: 'Always allow for this workspace' }).click();
      await expect(page.getByRole('heading', { name: explanation.heading })).toBeInViewport();
    });
    await page.getByRole('button', { name: 'Lesson notes' }).click();
    await expect(page.getByRole('button', { name: 'Revoke workspace tutor permission' })).toBeVisible();
  });
});

test('shows the exact opening request before sending, then cancels, retries and checks understanding', async ({ desktop: { page, directory } }) => {
  const home = join(directory, 'codex-home');
  const receipt = join(directory, 'request.json');
  const gate = join(directory, 'gate');
  const responseFile = join(directory, 'reply.json');
  mkdirSync(home);
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.1-terra"\n');
  writeOpening(directory);
  writeFileSync(gate, '');
  await add(page).click();
  await typeTopic(page, 'IP routing');
  await page.getByText('Exact request', { exact: true }).click();
  const exact = page.getByLabel('Exact provider request');
  await expect(exact).toBeVisible();
  const prompt = await exact.innerText();
  const override = process.env.DELVE_CODEX_MODEL;
  const model = override ?? 'gpt-6.1-terra';
  await expect(page.locator('#topic-request-summary')).toContainText(
    override === undefined ? 'gpt-6.1-terra · from Codex config' : `Requested model: ${model}`);
  await expect(page.locator('#topic-request-summary')).toContainText(Buffer.byteLength(prompt).toLocaleString('en-US') + ' bytes');
  expect(existsSync(receipt)).toBe(false);

  await start(page).click();
  await expect.poll(() => existsSync(receipt)).toBe(true);
  const invocation = JSON.parse(readFileSync(receipt, 'utf8'));
  expect(invocation.stdin).toBe(prompt);
  expect(invocation.argv[invocation.argv.indexOf('--model') + 1]).toBe(model);
  await page.getByRole('button', { name: 'Cancel tutor request', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cancelled');
  unlinkSync(gate);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('region', { name: 'Review what will be sent' }).getByRole('button', { name: 'Allow once and continue' }).click();
  await expect(page.getByRole('heading', { name: explanation.heading })).toBeVisible();

  writeFileSync(responseFile, JSON.stringify({ assessment: true, observation: 'You recognized prefix specificity.', reasoningFeedback: 'A smaller destination range makes the match more specific.',
    recommendation: null,
    lesson: { schema: 'delve.lesson/1', source: null, blocks: [{ type: 'trace', steps: ['Match destination', 'Compare lengths', 'Choose /24'] },
      { type: 'check', kind: 'prediction', prompt: 'A /20 and a /28 match. Which wins, and why?', options: ['The /20', 'Whichever is older', 'The /28', 'Neither'], expected: 2 }] } }));
  await page.getByRole('button', { name: 'It covers fewer addresses' }).click();
  await page.getByRole('textbox', { name: /Explain your reasoning/ }).fill('It covers a smaller destination network.');
  await page.getByRole('button', { name: 'Preview answer', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Exact provider request')).toContainText('It covers a smaller destination network.');
  const exactAnswer = await page.getByRole('dialog').getByLabel('Exact provider request').innerText();
  await page.keyboard.press(shortcut);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: 'Review what will be sent' })).toBeVisible();
  await exerciseAnswerRecovery(page, gate);
  await expect(page.getByRole('log')).toContainText('You recognized prefix specificity.');
  await expect(page.getByRole('log')).toContainText('A smaller destination range makes the match more specific.');
  await expect(page.getByRole('log')).toContainText('Choose /24');
  await expect(page.getByRole('heading', { name: 'A /20 and a /28 match. Which wins, and why?' })).toBeVisible();
  expect(JSON.parse(readFileSync(receipt, 'utf8')).stdin).toBe(exactAnswer);
  await expect(page.getByRole('meter', { name: 'Correct checks in a row' })).toHaveJSProperty('value', 1);
});

test('keeps an approved turn running in the background and reopens the lesson', async ({ desktop: { page, directory } }) => {
  const gate = join(directory, 'gate');
  writeOpening(directory);
  writeFileSync(gate, '');
  await add(page).click();
  await typeTopic(page, 'IP routing');
  await start(page).click();
  await page.getByRole('button', { name: 'Continue in background' }).click();

  const activity = page.getByRole('region', { name: 'Tutor activity' });
  await expect(activity).toContainText('Preparing lesson · IP routing');
  await page.getByRole('group', { name: 'Your workspaces' }).getByRole('button', { name: /^Archon/ }).click();
  await expect(page.getByRole('heading', { name: 'Repository atlas.' })).toBeVisible();
  unlinkSync(gate);
  await expect(activity).toContainText('Lesson ready · IP routing');
  await activity.getByRole('button', { name: 'Open lesson' }).click();
  await expect(page.getByRole('heading', { name: explanation.heading })).toBeVisible();
  await expect(activity).toHaveCount(0);
});

async function exerciseAnswerRecovery(page: Page, gate: string) {
  const choice = page.getByRole('button', { name: 'It covers fewer addresses' });
  const rationale = page.getByRole('textbox', { name: /Explain your reasoning/ });
  const meter = page.getByRole('meter', { name: 'Correct checks in a row' });
  writeFileSync(gate, '');
  await page.getByRole('dialog').getByRole('button', { name: 'Always allow for this workspace' }).click();
  await page.getByRole('button', { name: 'Cancel tutor request' }).click();
  await expect(page.getByRole('alert')).toContainText('cancelled');
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await expect(rationale).toHaveValue('It covers a smaller destination network.');
  await expect(meter).toHaveJSProperty('value', 0);
  unlinkSync(gate);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
}

function writeReply(directory: string) {
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({
    ...envelope, lesson: { schema: 'delve.lesson/1', source: null, blocks: [
      { type: 'prose', heading: 'IPv6 routing', text: 'The rule also applies to IPv6.' },
    ] },
  }));
}

test('keeps reading position and scopes tutor permission to a workspace and provider across launches', async ({ desktop }) => {
  const { page, directory } = desktop;
  writeOpening(directory, true);
  await add(page).click();
  await typeTopic(page, 'IP routing');
  await start(page).click();
  await expect(page.getByRole('heading', { name: explanation.heading })).toBeVisible();
  writeReply(directory);

  await page.getByRole('button', { name: 'Ask tutor', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'Ask your tutor' });
  await draft.fill('How does IPv6 work?');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Exact provider request')).toContainText('How does IPv6 work?');
  const gate = join(directory, 'gate');
  writeFileSync(gate, '');
  await dialog.getByRole('button', { name: 'Always allow for this workspace' }).click();
  await expect(page.getByText('Preparing response…')).toBeVisible();
  const transcript = page.locator('.reader-scroll');
  const readPosition = () => transcript.evaluate(node => node.scrollTop);
  await transcript.evaluate(node => node.scrollTo({ top: 30, behavior: 'instant' }));
  const position = await readPosition();
  expect(position).toBeGreaterThan(0);
  unlinkSync(gate);
  await expect(page.getByRole('log')).toContainText('The rule also applies to IPv6.');
  expect(await readPosition()).toBe(position);
  await page.getByRole('button', { name: 'New reply' }).click();
  await expect.poll(readPosition).toBeGreaterThan(position);

  await verifyPermissionAfterRestart(await desktop.restart(), directory);
});

async function verifyPermissionAfterRestart(restarted: Page, directory: string) {
  await restarted.getByRole('button', { name: 'Open lesson →' }).click();
  const notes = restarted.getByRole('button', { name: 'Lesson notes' });
  const closeNotes = restarted.getByRole('dialog').getByRole('button', { name: 'Close', exact: true });
  await notes.click();
  const revoke = restarted.getByRole('button', { name: 'Revoke workspace tutor permission' });
  await expect(revoke).toBeVisible();
  await restarted.getByLabel('Tutor', { exact: true }).selectOption('claude');
  await expect(revoke).toHaveCount(0);
  await restarted.getByLabel('Tutor', { exact: true }).selectOption('codex');
  await expect(revoke).toBeVisible();
  await closeNotes.click();
  await restarted.getByRole('button', { name: 'Ask tutor', exact: true }).click();
  await restarted.getByRole('textbox', { name: 'Ask your tutor' }).fill('Does this persist?');
  await restarted.getByRole('button', { name: 'Ask question' }).click();
  await expect(restarted.getByRole('log')).toContainText('Does this persist?');
  await notes.click();
  await revoke.click();
  await closeNotes.click();
  await restarted.getByRole('textbox', { name: 'Ask your tutor' }).fill('Another example?');
  await restarted.getByRole('button', { name: 'Ask question' }).click();
  const afterRevoking = restarted.getByRole('region', { name: 'Review what will be sent' });
  await expect(afterRevoking.getByRole('button', { name: 'Allow once and continue' })).toBeVisible();
  await afterRevoking.getByRole('button', { name: 'Always allow for this workspace' }).click();
  await expect(restarted.getByRole('log')).toContainText('Another example?');
  await notes.click();
  await expect(revoke).toBeVisible();

  await closeNotes.click();
  writeOpening(directory);
  await add(restarted).click();
  await typeTopic(restarted, 'Acoustics');
  await start(restarted).click();
  await expect(restarted.getByRole('heading', { name: explanation.heading })).toBeVisible();
  await notes.click();
  await expect(revoke).toHaveCount(0);
}
