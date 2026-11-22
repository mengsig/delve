import { expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DelveApi } from '../../src/shared/ipc';
import { test } from './desktop';
import { withinBudget } from './action-budget';

test.use({ tutorCli: true, firstRun: true });

function createRepository(directory: string, extraFiles: Record<string, string> = {}) {
  const repo = join(directory, 'dispatch');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--template=', '--initial-branch=main', repo]);
  const data = (value: string) => 'data ' + Buffer.byteLength(value) + '\n' + value + '\n';
  const content = ['export const attempts = 1;\n', 'export const attempts = 3;\n'];
  const commits = content.map((file, i) => {
    const title = i ? 'Retry a failed dispatch' : 'Dispatch once';
    const files = i === 0 ? { 'dispatch.ts': file } : { 'dispatch.ts': file, ...extraFiles };
    return ['commit refs/heads/main', 'committer Fixture <fixture@example.invalid> ' + (1000000000 + i) + ' +0000',
      data(title).trimEnd(), ...Object.entries(files).flatMap(([path, contents]) => [`M 100644 inline ${path}`, data(contents)])].join('\n');
  });
  execFileSync('git', ['-C', repo, 'fast-import', '--quiet'], { input: commits.join('\n') + '\ndone\n' });
  return { repo, head: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
}

const concept = { key: 'dispatch/retries', title: 'Dispatch retries', portable: false, summary: 'A failed dispatch can be attempted again.' };
const graph = { concepts: [concept], edges: [], recommendation: { key: concept.key, reason: 'Follow how the dispatcher handles a failed delivery.' } };

async function capture(page: Page, info: TestInfo, name: string) {
  await page.locator('header.windowbar').scrollIntoViewIfNeeded();
  const path = info.outputPath(name + '.png');
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function generateBrief(page: Page, directory: string, depth: 'medium' | 'low') {
  const what = depth === 'medium' ? 'Dispatch now allows three delivery attempts.' : 'The attempts constant increases from 1 to 3.';
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ ...graph, schema: 'delve.change/1', touched: [concept.key], what,
    summary: 'Allow a transient failure to recover on another attempt.', why: 'A later attempt can succeed after a transient failure.',
    before: 'One attempt ends delivery.', after: 'The dispatcher can attempt delivery three times.',
    mechanics: 'The dispatcher can repeat the delivery when the first attempt fails.',
    boundary: depth === 'low' ? 'The third attempt is the final opportunity to deliver.' : null,
    trace: ['Dispatch request', 'Delivery attempt', 'Retry decision'], excerpt: depth === 'low' ? ['+export const attempts = 3;'] : [] }));
  const requestFile = join(directory, 'request.json');
  const lastRequest = readFileSync(requestFile, 'utf8');
  const selected = page.getByRole('region', { name: 'Selected change' });
  const review = selected.getByRole('region', { name: 'Review provider request' });
  await review.getByText('Exact request', { exact: true }).click();
  const prompt = await review.getByLabel('Exact provider request').innerText();
  expect(readFileSync(requestFile, 'utf8')).toBe(lastRequest);
  expect(prompt).toContain('"depth":"' + depth + '"');
  expect(prompt).toContain('+export const attempts = 3;');
  const gate = join(directory, 'gate');
  if (depth === 'medium') writeFileSync(gate, '');
  await withinBudget(page, 'Approve and request a commit lesson in one click', 1, async () => {
    await review.getByRole('button', { name: 'Teach me this change' }).click();
    if (depth === 'low') await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible();
  });
  if (depth === 'medium') {
    await page.getByRole('button', { name: 'Progress', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Repository generation' }).getByRole('progressbar')).toBeVisible();
    unlinkSync(gate);
    const open = page.getByRole('button', { name: 'Open change brief', exact: true });
    await expect(open).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your field record.' })).toBeVisible();
    await open.click();
  }
  await expect(page.getByText(what, { exact: true })).toBeVisible();
  expect(JSON.parse(readFileSync(requestFile, 'utf8')).stdin).toBe(prompt);
}

async function addAndMap(page: Page, directory: string, repo: string, info: TestInfo) {
  const gate = join(directory, 'gate');
  await page.locator('#source-input').focus();
  await page.keyboard.insertText(repo);
  const review = page.getByRole('region', { name: 'Review provider request' });
  await expect(review).toContainText('dispatch.ts');
  const prompt = await review.locator('pre').textContent();
  expect(prompt).toContain('export const attempts = 3;');
  await page.getByRole('form', { name: 'Add workspace' }).screenshot({ path: info.outputPath('attach-preview.png') });
  expect(existsSync(join(directory, 'request.json'))).toBe(false);
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ ...graph, schema: 'delve.map/1' }));
  writeFileSync(gate, '');
  const jobs = page.getByRole('region', { name: 'Repository generation' });
  await withinBudget(page, 'Map a pasted local repository in place with one confirmation', 1, async () => {
    await page.getByRole('button', { name: 'Add and build map' }).click();
    await expect(jobs.getByRole('progressbar')).toBeVisible();
    await capture(page, info, 'background-map');
    unlinkSync(gate);
    await expect(page.getByLabel('Field guide')).toContainText(graph.recommendation.reason);
    await expect(jobs.getByText(/Map ready/)).toBeVisible();
  });
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await jobs.getByRole('button', { name: 'Open map', exact: true }).click();
  await expect(page.getByLabel('Field guide')).toContainText(graph.recommendation.reason);
  expect(JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8')).stdin).toBe(prompt);
}

async function askTutor(page: Page, directory: string) {
  const answer = 'A retry is useful when a failure can clear between attempts.';
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ lesson: { schema: 'delve.lesson/1', source: null,
    blocks: [{ type: 'prose', heading: 'Transient failures', text: answer }] }, recommendation: null, assessment: null, observation: null }));
  await page.getByRole('button', { name: 'Close preview' }).click();
  await page.getByRole('button', { name: 'Ask tutor', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask your tutor' }).fill('When does another attempt help?');
  await page.getByRole('button', { name: 'Ask question' }).click();
  const preview = page.getByRole('region', { name: 'Review what will be sent' });
  await preview.getByText('Exact request', { exact: true }).click();
  await expect(preview).toContainText('The attempts constant increases from 1 to 3.');
  await preview.getByRole('button', { name: 'Allow once and continue' }).click();
  await expect(page.getByRole('log')).toContainText(answer);
}

test('edits the filtered file slice without changing hidden files or sending the request', async ({ desktop }, info) => {
  const { page, directory } = desktop;
  const { repo } = createRepository(directory, { 'README.md': '# Dispatch\n', 'src/worker.ts': 'export const workers = 2;\n' });
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.locator('#source-input').fill(repo);
  await page.getByText('Edit files (3 selected)', { exact: true }).click();
  const filter = page.getByLabel('Filter repository files');
  await filter.fill('SRC/');
  await expect(page.getByRole('checkbox', { name: 'src/worker.ts' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'README.md' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear visible' }).click();
  await expect(page.getByRole('checkbox', { name: 'src/worker.ts' })).not.toBeChecked();
  const requested = page.getByRole('list', { name: 'Files included in the request' });
  await expect(requested.getByRole('listitem')).toHaveText(['README.md', 'dispatch.ts']);
  await page.getByRole('button', { name: 'Select visible' }).press('Enter');
  await expect(page.getByRole('checkbox', { name: 'src/worker.ts' })).toBeChecked();
  await expect(requested.getByRole('listitem')).toHaveText(['README.md', 'dispatch.ts', 'src/worker.ts']);
  await page.getByText('Exact request', { exact: true }).click();
  await expect(page.getByLabel('Exact provider request')).toContainText('export const workers = 2;');
  expect(existsSync(join(directory, 'request.json'))).toBe(false);
  await page.getByText('Exact request', { exact: true }).click();
  await filter.focus();
  await capture(page, info, 'file-selection-after');
  if (process.env['DELVE_NIGHT_EVIDENCE']) {
    mkdirSync('.archon/evidence', { recursive: true });
    await page.screenshot({ path: '.archon/evidence/file-selection-after.png' });
  }
});

test('maps approved files, teaches one commit at two depths and previews an incoming link before opening its saved conversation', async ({ desktop }, info) => {
  const { page, directory } = desktop;
  const { repo, head } = createRepository(directory);
  await page.setViewportSize({ width: 1200, height: 960 });
  await expect(page.getByRole('heading', { name: 'What will you explore?' })).toBeVisible();
  await expect(page.locator('[data-provider="codex"]')).toHaveAttribute('data-state', 'signed-in');
  await capture(page, info, 'first-run');
  await addAndMap(page, directory, repo, info);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('option', { name: /Retry a failed dispatch/ }).click();
  await generateBrief(page, directory, 'medium');
  await capture(page, info, 'medium-change');
  await page.getByLabel('Reading depth').selectOption('low');
  await generateBrief(page, directory, 'low');
  await page.getByRole('button', { name: '← Back to change brief' }).click();
  await expect(page.locator('.lesson-code')).toContainText('+export const attempts = 3;');
  const id = await page.evaluate(async () => {
    const list = await (globalThis as unknown as { delve: DelveApi }).delve.invoke('workspaces:list', null);
    if (!list.ok || !list.value.activeId) throw new Error('Expected the imported repository.');
    return list.value.activeId;
  });
  const again = await desktop.restart('delve://learn?workspace=' + id + '&commit=' + head);
  const incoming = again.getByRole('region', { name: 'Incoming learn link' });
  await expect(incoming).toContainText(head);
  await expect(again.getByRole('heading', { name: 'Repository atlas.' })).toBeVisible();
  await incoming.getByRole('button', { name: 'Accept and open' }).click();
  await expect(again.getByText('Saved brief · available offline')).toBeVisible();
  await again.getByRole('button', { name: 'Teach me this change' }).click();
  await expect(again.getByRole('heading', { name: 'What changed' })).toBeVisible();
  await askTutor(again, directory);
});

test('accepts a folder dropped into the initial repository field and offers a recovery action on an unreadable source', async ({ desktop }) => {
  const { page, directory } = desktop;
  const { repo } = createRepository(directory);
  await page.locator('#source-input').fill(join(directory, 'absent'));
  await expect(page.getByRole('button', { name: 'Retry reading files' })).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  const rect = await page.locator('#source-input').boundingBox();
  if (!rect) throw new Error('Expected the source field to be visible.');
  const point = { x: rect.x + 10, y: rect.y + 10, data: { items: [], files: [repo], dragOperationsMask: 1 } };
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, ...point });
  await cdp.detach();
  await expect(page.locator('#source-input')).toHaveValue(repo);
  await expect(page.getByRole('button', { name: 'Add and build map' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(existsSync(join(directory, 'request.json'))).toBe(false);
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ ...graph, schema: 'delve.map/1' }));
  await withinBudget(page, 'Map a dropped folder in place with one confirmation', 1, async () => {
    await page.getByRole('button', { name: 'Add and build map' }).click();
    await expect(page.getByLabel('Field guide')).toContainText(concept.title);
  });
});

test.describe('model rejection', () => {
  test.use({ providerMode: 'model-rejected' });

  test('shows the configured model and a useful account error', async ({ desktop }) => {
    const { page, directory } = desktop;
    const { repo } = createRepository(directory);
    const config = join(directory, 'codex-home');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'config.toml'), 'model = "gpt-test"\n');
    await page.locator('#source-input').fill(repo);
    const review = page.getByRole('region', { name: 'Review provider request' });
    await expect(review).toContainText('gpt-test · from Codex config');
    await page.getByRole('button', { name: 'Add and build map' }).click();
    const jobs = page.getByRole('region', { name: 'Repository generation' });
    await expect(jobs).toContainText('Codex rejected the requested model gpt-test');
    await expect(jobs).toContainText('update the model in Codex config');
    const call = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8')) as { argv: string[] };
    expect(call.argv.slice(call.argv.indexOf('--model'), call.argv.indexOf('--model') + 2)).toEqual(['--model', 'gpt-test']);
  });
});
