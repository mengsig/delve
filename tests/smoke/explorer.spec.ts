import { expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DelveApi } from '../../src/shared/ipc';
import { test } from './desktop';
import { baseline, concept, createExplorerFixture, newConcept, prTitle, writeExplanation } from './explorer-fixture';

test.use({ tutorCli: true, firstRun: true, fixtureGitHub: true });
test.skip(process.platform === 'win32', 'The GitHub CLI fixture uses a POSIX executable shim.');

async function mapFixture(page: Page, path: string, directory: string) {
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ ...baseline, schema: 'delve.map/1' }));
  await page.locator('#source-input').focus();
  await page.keyboard.insertText(path);
  await test.step('Open the map in place with one confirmation', async () => {
    await page.getByRole('button', { name: 'Add and build map' }).click();
    await expect(page.getByLabel('Field guide')).toContainText(concept.title);
  });
  await page.getByRole('region', { name: 'Repository generation' }).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
}

async function evidence(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name + '.png');
  await page.locator('header.windowbar').scrollIntoViewIfNeeded();
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function openTab(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).click();
  const panel = page.getByRole('tabpanel', { name, exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

async function workspaceId(page: Page) {
  const id = await page.evaluate(async () => {
    const list = await (globalThis as unknown as { delve: DelveApi }).delve.invoke('workspaces:list', null);
    if (!list.ok) throw new Error(list.error.message);
    return list.value.activeId;
  });
  expect(id).toBeTruthy();
  return id;
}

async function verifyCommit(page: Page) {
  const selected = page.getByRole('region', { name: 'Selected change' });
  await test.step('Open a commit from history in one click', async () => {
    await page.getByRole('option', { name: /Retry a failed dispatch/ }).click();
    await expect(selected.getByRole('heading', { name: 'Retry a failed dispatch' })).toBeVisible();
  });
  await expect(await openTab(page, 'Explanation')).toContainText('What changed and why');
  await expect(await openTab(page, 'Files changed')).toContainText('+  const attempts = 3;');
  await expect(await openTab(page, 'Concepts')).toContainText('Teach me this change');
  await page.keyboard.press('Escape');
  await expect(page.locator('#change-timeline')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(selected).toBeFocused();
  await expect(selected.getByRole('heading', { name: 'Retry a failed dispatch' })).toHaveCount(0);
}

async function teachPullRequest(page: Page, directory: string) {
  const selected = page.getByRole('region', { name: 'Selected change' });
  unlinkSync(join(directory, 'request.json'));
  writeExplanation(directory);
  const review = selected.getByRole('region', { name: 'Review provider request' });
  await test.step('Inspect the exact pull request source in one click', async () => {
    await review.getByText('Exact request', { exact: true }).click();
    await expect(review.getByLabel('Exact provider request')).toContainText('+  const attempts = 3;');
  });
  await review.getByRole('checkbox', { name: /Always allow change lesson requests/ }).check();
  expect(existsSync(join(directory, 'request.json'))).toBe(false);
  await test.step('Approve and open a new pull request lesson in one click', async () => {
    await selected.getByRole('button', { name: 'Teach me this change' }).click();
    await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible();
  });
}

test('opens both change types and all tabs, teaches a PR and follows a mapped line to the Atlas', async ({ desktop }, info) => {
  const { directory, page } = desktop;
  createExplorerFixture(directory);
  await page.setViewportSize({ width: 1360, height: 1000 });
  await mapFixture(page, 'https://github.com/contour/dispatch', directory);
  const selected = page.getByRole('region', { name: 'Selected change' });
  await page.getByRole('option', { name: /Merge delivery retries/ }).click();
  await expect(selected.getByRole('heading', { name: 'Merge delivery retries' })).toBeVisible();
  await test.step('Open a GitHub pull request from history in one click', async () => {
    await page.getByRole('option', { name: new RegExp(prTitle) }).click();
    await expect(selected.getByRole('heading', { name: prTitle })).toBeVisible();
  });
  await expect(selected).toContainText('mayachen');
  await expect(selected).toContainText('Merged', { ignoreCase: true });
  await expect(await openTab(page, 'Explanation')).toContainText('Delivery workers');
  await expect(await openTab(page, 'Files changed')).toContainText('Partial coverage');
  await expect(await openTab(page, 'Concepts')).toContainText('Teach me this change');
  await teachPullRequest(page, directory);
  await page.getByRole('button', { name: '← Back to change brief' }).click();
  await expect(await openTab(page, 'Explanation')).toContainText('A short network interruption');
  const job = page.getByRole('region', { name: 'Repository generation' });
  await job.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await evidence(page, info, 'explorer-light');
  const concepts = await openTab(page, 'Concepts');
  await expect(concepts).toContainText(concept.title);
  const introduced = concepts.getByRole('listitem').filter({ hasText: newConcept.title });
  await introduced.getByRole('button', { name: 'View on Atlas' }).click();
  await expect(page.getByLabel('Selected concept')).toContainText(newConcept.title);
  await page.getByRole('button', { name: 'Return to reviewed map' }).click();
  await expect(page.getByLabel('Selected concept')).toContainText(concept.title);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  const files = await openTab(page, 'Files changed');
  const link = files.getByRole('button', { name: concept.title + ' ↗' });
  await expect(link).toBeVisible();
  await page.getByRole('button', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await evidence(page, info, 'explorer-dark');
  await link.click();
  await expect(page.getByLabel('Selected concept')).toContainText(concept.title);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await verifyCommit(page);
  const again = await desktop.restart('delve://learn?workspace=' + await workspaceId(page) + '&pr=42');
  await again.getByRole('button', { name: 'Accept and open' }).click();
  await expect(again.getByRole('heading', { name: prTitle, exact: true })).toBeVisible();
  await verifyRememberedApproval(again, directory);
  await test.step('Open the saved pull request lesson in one click', async () => {
    await again.getByRole('button', { name: 'Teach me this change' }).click();
    await expect(again.getByRole('article', { name: 'Lesson and conversation' })).toBeVisible();
  });
});

async function verifyRememberedApproval(page: Page, directory: string) {
  const request = join(directory, 'request.json');
  const sent = readFileSync(request, 'utf8');
  const depth = page.getByLabel('Reading depth');
  await depth.selectOption('high');
  const selected = page.getByRole('region', { name: 'Selected change' });
  const preview = selected.getByText('Preview diff request', { exact: true });
  await expect(preview).toBeVisible();
  await preview.click();
  await expect(selected.getByLabel('Exact provider request')).toContainText('"depth":"high"');
  await selected.getByRole('button', { name: 'Revoke always allow' }).click();
  await expect(selected.getByRole('checkbox', { name: /Always allow change lesson requests/ })).not.toBeChecked();
  expect(readFileSync(request, 'utf8')).toBe(sent);
  await depth.selectOption('medium');
}

test('keeps commit history usable when GitHub has no PRs or needs sign-in', async ({ desktop }) => {
  const { directory, page } = desktop;
  const { path } = createExplorerFixture(directory);
  const fixture = join(directory, 'github.json');
  const response = JSON.parse(readFileSync(fixture, 'utf8'));
  writeFileSync(fixture, JSON.stringify({ ...response, empty: true }));
  await mapFixture(page, path, directory);
  await expect(page.getByText(/no pull requests/i).first()).toBeVisible();
  const commits = page.getByRole('listbox').getByRole('option');
  await expect(commits.first()).toBeVisible();
  expect(await commits.count()).toBeLessThan(30);
  await page.getByRole('button', { name: 'Folio', exact: true }).click();
  await page.getByRole('combobox', { name: 'Branch', exact: true }).selectOption('main');
  await page.getByLabel('Author', { exact: true }).fill('Maya');
  await page.getByLabel('Search history').fill('Start the dispatcher');
  await expect(commits.first()).toContainText('Start the dispatcher');
  await commits.first().click();
  await expect(page.getByRole('region', { name: 'Selected change' })).toContainText('Start the dispatcher');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(commits.first()).toContainText('Merge delivery retries');
  writeFileSync(fixture, JSON.stringify({ ...response, signedOut: true }));
  await page.getByRole('button', { name: /^refresh/i }).first().click();
  await expect(page.getByText(/run gh auth login/i).first()).toBeVisible();
  await page.getByRole('option', { name: /Retry a failed dispatch/ }).click();
  await expect(await openTab(page, 'Files changed')).toContainText('+  const attempts = 3;');
});

test('reloads a moved PR and keeps the saved lesson readable offline', async ({ desktop }) => {
  const { directory, page } = desktop;
  const { path } = createExplorerFixture(directory);
  await mapFixture(page, path, directory);
  await page.getByRole('option', { name: new RegExp(prTitle) }).click();
  writeExplanation(directory);
  await page.getByRole('button', { name: 'Teach me this change' }).click();
  await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← Back to change brief' }).click();
  await expect(page.getByText('Saved brief · available offline')).toBeVisible();
  const fixture = join(directory, 'github.json');
  const response = JSON.parse(readFileSync(fixture, 'utf8'));
  response.pr.head.sha = 'd'.repeat(40);
  writeFileSync(fixture, JSON.stringify(response));
  const refresh = page.getByRole('button', { name: 'Refresh history' });
  await refresh.click();
  await expect(page.getByText(/has changed since its last explanation/)).toBeVisible();
  await expect(page.getByText('Saved brief · available offline')).toHaveCount(0);
  writeFileSync(fixture, JSON.stringify({ ...response, signedOut: true }));
  await refresh.click();
  await expect(page.getByText('Saved brief · available offline')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected change' })).toContainText('Showing the saved change.');
  await page.getByRole('button', { name: 'Teach me this change' }).click();
  await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible();
});

test('shows the empty history of a new Git repository', async ({ desktop }) => {
  const repo = join(desktop.directory, 'new-repository');
  execFileSync('git', ['init', '--quiet', '--template=', '--initial-branch=main', repo]);
  await desktop.page.locator('#source-input').fill(repo);
  await desktop.page.getByRole('button', { name: 'Add to atlas' }).click();
  await desktop.page.getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(desktop.page.getByText('No commits or pull requests are available.')).toBeVisible();
  await expect(desktop.page.getByRole('listbox')).toHaveCount(0);
});
