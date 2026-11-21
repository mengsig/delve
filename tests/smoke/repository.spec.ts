import { expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DelveApi } from '../../src/shared/ipc';
import { test } from './desktop';

test.use({ tutorCli: true, firstRun: true });

function createRepository(directory: string) {
  const repo = join(directory, 'dispatch');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--template=', '--initial-branch=main', repo]);
  const data = (value: string) => 'data ' + Buffer.byteLength(value) + '\n' + value + '\n';
  const content = ['export const attempts = 1;\n', 'export const attempts = 3;\n'];
  const commits = content.map((file, i) => {
    const title = i ? 'Retry a failed dispatch' : 'Dispatch once';
    return ['commit refs/heads/main', 'committer Fixture <fixture@example.invalid> ' + (1000000000 + i) + ' +0000',
      data(title).trimEnd(), 'M 100644 inline dispatch.ts', data(file)].join('\n');
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
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ ...graph, schema: 'delve.change/1', what,
    summary: 'Allow a transient failure to recover on another attempt.', why: 'A later attempt can succeed after a transient failure.',
    before: 'One attempt ends delivery.', after: 'The dispatcher can attempt delivery three times.',
    mechanics: 'The dispatcher can repeat the delivery when the first attempt fails.',
    boundary: depth === 'low' ? 'The third attempt is the final opportunity to deliver.' : null,
    trace: ['Dispatch request', 'Delivery attempt', 'Retry decision'], excerpt: depth === 'low' ? ['+export const attempts = 3;'] : [] }));
  await page.getByRole('button', { name: 'Preview diff request' }).click();
  const review = page.getByRole('region', { name: 'Review provider request' });
  const prompt = await review.locator('pre').innerText();
  expect(prompt).toContain('"depth":"' + depth + '"');
  expect(prompt).toContain('+export const attempts = 3;');
  await review.getByRole('button', { name: 'Approve and explain' }).click();
  await expect(page.getByText(what, { exact: true })).toBeVisible();
  expect(JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8')).stdin).toBe(prompt);
}

test('maps approved files, teaches one commit at two depths and previews an incoming link before opening its saved conversation', async ({ desktop }, info) => {
  const { page, directory } = desktop;
  const { repo, head } = createRepository(directory);
  await page.setViewportSize({ width: 1200, height: 960 });
  await expect(page.getByRole('heading', { name: 'What will you explore?' })).toBeVisible();
  await expect(page.locator('[data-provider="codex"]')).toHaveAttribute('data-state', 'signed-in');
  await capture(page, info, 'first-run');
  await page.getByRole('button', { name: 'Local folder', exact: true }).click();
  await page.getByLabel('Local folder', { exact: true }).fill(repo);
  await page.locator('[data-provider="codex"]').click();
  await page.getByRole('button', { name: 'Add to atlas →' }).click();
  await expect(page.getByRole('checkbox', { name: 'dispatch.ts' })).toBeChecked();
  await page.getByRole('button', { name: 'Preview map request' }).click();
  const review = page.getByRole('region', { name: 'Review provider request' });
  const prompt = await review.locator('pre').innerText();
  expect(prompt).toContain('export const attempts = 3;');
  expect(existsSync(join(directory, 'request.json'))).toBe(false);
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ ...graph, schema: 'delve.map/1' }));
  await review.getByRole('button', { name: 'Approve and map' }).click();
  await expect(page.getByLabel('Field guide')).toContainText(graph.recommendation.reason);
  expect(JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8')).stdin).toBe(prompt);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('button', { name: /Retry a failed dispatch/ }).click();
  await generateBrief(page, directory, 'medium');
  await capture(page, info, 'medium-change');
  await page.getByRole('button', { name: /Low · Protocol detail/ }).click();
  await generateBrief(page, directory, 'low');
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
  await again.getByRole('button', { name: 'Ask about this change →' }).click();
  await expect(again.getByRole('heading', { name: 'What changed' })).toBeVisible();
});
