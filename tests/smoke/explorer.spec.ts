import { expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DelveApi } from '../../src/shared/ipc';
import { test } from './desktop';
import { withinBudget } from './action-budget';
import { baseline, concept, createExplorerFixture, newConcept, prTitle, writeExplanation } from './explorer-fixture';

test.use({ tutorCli: true, firstRun: true, fixtureGitHub: true });
test.skip(process.platform === 'win32', 'The GitHub CLI fixture uses a POSIX executable shim.');

async function mapFixture(page: Page, path: string, directory: string, fromAtlas = false) {
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ ...baseline, schema: 'delve.map/1' }));
  if (fromAtlas) await page.getByRole('button', { name: 'Explore demo atlas' }).click();
  await withinBudget(page, 'Paste a repository and open its map', fromAtlas ? 2 : 1, async () => {
    if (fromAtlas) await page.getByRole('button', { name: 'Add a workspace', exact: true }).click();
    await expect(page.locator('#source-input')).toBeFocused();
    await page.keyboard.insertText(path);
    const build = page.getByRole('button', { name: 'Add and build map' });
    await expect(build).toBeInViewport({ ratio: 1 });
    await build.click();
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
  await withinBudget(page, 'Open a commit from history in one click', 1, async () => {
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
  await withinBudget(page, 'Inspect the exact pull request source in one click', 1, async () => {
    await review.getByText('Exact request', { exact: true }).click();
    await expect(review.getByLabel('Exact provider request')).toContainText('+  const attempts = 3;');
  });
  await review.getByRole('checkbox', { name: /Always allow change lesson requests/ }).check();
  expect(existsSync(join(directory, 'request.json'))).toBe(false);
  await withinBudget(page, 'Approve and open a new pull request lesson in one click', 1, async () => {
    await selected.getByRole('button', { name: 'Teach me this change' }).click();
    await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible();
  });
}

test('opens both change types and all tabs, teaches a PR and follows a mapped line to the Atlas', async ({ desktop }, info) => {
  const { directory, page } = desktop;
  createExplorerFixture(directory);
  await page.setViewportSize({ width: 1280, height: 800 });
  await mapFixture(page, 'https://github.com/contour/dispatch', directory, true);
  const selected = page.getByRole('region', { name: 'Selected change' });
  await page.getByRole('option', { name: /Merge delivery retries/ }).click();
  await expect(selected.getByRole('heading', { name: 'Merge delivery retries' })).toBeVisible();
  await withinBudget(page, 'Open a GitHub pull request from history in one click', 1, async () => {
    await page.getByRole('option', { name: new RegExp(prTitle) }).click();
    await expect(selected.getByRole('heading', { name: prTitle })).toBeVisible();
  });
  await expect(selected).toContainText('mayachen');
  await expect(selected).toContainText('Merged', { ignoreCase: true });
  await expect(await openTab(page, 'Explanation')).toContainText('Delivery workers');
  await expect(await openTab(page, 'Files changed')).toContainText('Partial coverage');
  await expect(await openTab(page, 'Concepts')).toContainText('Teach me this change');
  await page.getByRole('button', { name: 'Atlas', exact: true }).click();
  await withinBudget(page, 'Continue the selected pull request from Atlas', 1, async () => {
    await page.getByRole('button', { name: new RegExp('Continue change ' + prTitle) }).click();
    await expect(selected.getByRole('heading', { name: prTitle })).toBeVisible();
  });
  await expect(selected.getByRole('button', { name: 'Teach me this change' })).toBeInViewport({ ratio: 1 });
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
  await withinBudget(again, 'Open the saved pull request lesson in one click', 1, async () => {
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

const receiptProbe = { type: 'check', kind: 'prediction',
  prompt: 'A package goes missing. What tells the sender it never arrived?',
  options: ['No confirmation comes back', 'The package gets heavier', 'A second package appears', 'The address changes'], expected: 0 };
const receiptPractice = { ...receiptProbe, prompt: 'The recipient signs for a package. What can the sender do now?',
  options: ['Send another package', 'Stop waiting for confirmation', 'Erase the address', 'Change the contents'], expected: 1 };
const reviewFoundations = [{
  key: 'delivery-confirmation', title: 'Delivery confirmation',
  summary: 'A confirmation tells the sender that a message arrived. Think of signing for a package.',
  why: 'This change depends on knowing whether the first delivery made it.', probe: receiptProbe, practice: receiptPractice,
}, {
  key: 'temporary-failures', title: 'Temporary failures', summary: 'A temporary problem can clear on its own.',
  why: 'Trying again can help when a problem clears.',
  probe: { ...receiptProbe, prompt: 'A road is blocked for a minute. When might you get through?',
    options: ['After the road clears', 'Before leaving home', 'When the road is longer', 'Never'], expected: 0 },
  practice: { ...receiptPractice, prompt: 'A phone call drops in a tunnel. What should you try after getting out?',
    options: ['Wait in the tunnel', 'Call again', 'Remove the number', 'Turn off the phone'], expected: 1 },
}];
const secondPr = 'Retry transient failure in dispatch.ts';
const plainChangeTitle = 'Give a failed delivery another chance';
const simpleExample = 'Think of calling a friend back after a dropped call. A second try might get through.';

async function answerChangeFoundations(page: Page, info: TestInfo) {
  const probe = page.getByRole('region', { name: 'What do you know about Delivery confirmation?' });
  await expect(probe).toContainText('Quick questions · 1 of 2');
  await expect(probe.getByRole('heading')).toBeFocused();
  await expect(probe.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toHaveCount(0);
  await evidence(page, info, 'foundation-probe');
  await probe.getByRole('button', { name: 'A second package appears' }).click();
  const second = page.getByRole('region', { name: 'What do you know about Temporary failures?' });
  await expect(second).toContainText('Quick questions · 2 of 2');
  await second.getByRole('button', { name: 'After the road clears' }).click();
  const practice = page.getByRole('region', { name: 'A quick look at Delivery confirmation' });
  await expect(practice).toContainText('Think of signing for a package.');
  await expect(practice.getByRole('button', { name: 'Skip to lesson' })).toBeVisible();
  await evidence(page, info, 'foundation-practice');
  await practice.getByRole('button', { name: 'Stop waiting for confirmation' }).click();
  await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible();
  await expect(page.getByLabel('Lesson transcript')).toContainText('This builds on Delivery confirmation, which you just went through.');
  await expect(page.getByLabel('Lesson transcript').getByText(simpleExample, { exact: true })).toBeVisible();
  await evidence(page, info, 'high-depth-lesson');
}

test('checks unfamiliar foundations before a high-depth PR and remembers them for the next PR', async ({ desktop: { page, directory } }, info) => {
  createExplorerFixture(directory);
  const fixture = join(directory, 'github.json');
  const { pr, files } = JSON.parse(readFileSync(fixture, 'utf8'));
  writeFileSync(fixture, JSON.stringify({ pr, files, additionalPrs: [{ ...pr, number: 43, title: secondPr }] }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await mapFixture(page, 'https://github.com/contour/dispatch', directory, true);
  await page.getByRole('option', { name: new RegExp(prTitle) }).click();
  await page.getByLabel('Reading depth').selectOption('high');
  writeExplanation(directory, { foundations: reviewFoundations, example: simpleExample, conceptTitle: plainChangeTitle,
    recommendation: { key: null, reason: 'See what happens when a delivery gets another chance.' },
    what: 'When a delivery fails, the worker can try again.', why: 'A short outage is less likely to lose a delivery.',
    mechanics: null, summary: 'A failed delivery gets another chance.' });
  await page.getByRole('button', { name: 'Teach me this change' }).click();
  await answerChangeFoundations(page, info);
  await page.getByRole('button', { name: '← Back to change brief' }).click();
  const explanation = page.getByRole('tabpanel', { name: 'Explanation' });
  const details = explanation.getByText('Evidence', { exact: true });
  await expect(details).toBeVisible();
  await expect(explanation.getByText(/Partial coverage/)).toBeHidden();
  await details.click();
  await expect(explanation.getByText(/Partial coverage/)).toBeVisible();
  await evidence(page, info, 'high-depth-brief');
  await page.getByRole('option', { name: new RegExp(secondPr) }).click();
  await page.getByRole('button', { name: 'Teach me this change' }).click();
  await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible();
  await expect(page.getByLabel('Lesson transcript').getByText(/which you already know\./)).toBeVisible();
  await expect(page.getByText(/Quick questions/)).toHaveCount(0);
  await expect(page.getByText(/Foundation lesson/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Atlas', exact: true }).click();
  const guide = page.getByLabel('Field guide');
  const suggestion = guide.getByRole('button', { name: new RegExp(plainChangeTitle) });
  await expect(suggestion).toBeVisible();
  await expect(guide.getByText(secondPr, { exact: true })).toBeHidden();
  await guide.getByText('Source title', { exact: true }).click();
  await expect(guide.getByText(secondPr, { exact: true })).toBeVisible();
  await suggestion.click();
  await expect(page.getByRole('heading', { name: secondPr, exact: true })).toBeVisible();
  await page.getByLabel('Reading depth').selectOption('low');
  await page.getByRole('button', { name: 'Teach me this change' }).click();
  const deeper = page.getByRole('region', { name: 'Go deeper on Delivery confirmation' });
  await expect(deeper).toBeVisible();
  await evidence(page, info, 'after-go-deeper');
  await deeper.getByRole('button', { name: 'Skip to lesson' }).click();
  await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible();
});

async function verifyChangeKnowledge(page: Page, info: TestInfo, screenshot: string) {
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Knowledge map' })).toBeVisible();
  await page.getByLabel('Learning depth').selectOption('high');
  const finder = page.getByRole('button', { name: 'Find a concept' });
  if (await finder.getAttribute('aria-expanded') === 'false') await finder.click();
  const matches = page.getByLabel('Matching concepts');
  await expect(matches.getByRole('button', { name: plainChangeTitle, exact: true })).toHaveCount(1);
  await expect(matches.getByRole('status')).toHaveText('2 matches');
  await expect(page.locator('.knowledge-area-bar')).toContainText('2 concepts');
  await expect(page.getByRole('meter', { name: 'Concepts mastered' })).toHaveAttribute('aria-valuetext', '0 of 2');
  await evidence(page, info, screenshot);
}

test('keeps one Knowledge node when a PR footprint and brief teach the same idea', async ({ desktop: { page, directory } }, info) => {
  createExplorerFixture(directory);
  await page.setViewportSize({ width: 1100, height: 900 });
  await mapFixture(page, 'https://github.com/contour/dispatch', directory, true);
  const pull = page.getByRole('option', { name: new RegExp(prTitle) });
  await pull.click();
  await page.getByLabel('Reading depth').selectOption('high');
  writeExplanation(directory, { concepts: [concept, { ...newConcept, title: plainChangeTitle }], conceptTitle: plainChangeTitle,
    overviewConceptKey: newConcept.key,
    example: simpleExample, what: 'When a delivery fails, the worker can try again.', mechanics: null });
  await page.getByRole('button', { name: 'Teach me this change' }).click();
  await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible();
  await verifyChangeKnowledge(page, info, 'pr-knowledge-high');

  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await pull.click();
  await page.getByLabel('Reading depth').selectOption('low');
  writeExplanation(directory, { concepts: [concept, { ...newConcept, title: 'Dispatch retry budget',
    summary: 'The worker can make three delivery attempts.' }] });
  await page.getByRole('button', { name: 'Teach me this change' }).click();
  await expect(page.getByRole('heading', { name: 'How it works', exact: true })).toBeVisible();
  const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
  expect(request.stdin).toContain(`"changeConcepts":[{"key":"${newConcept.key}","title":"${plainChangeTitle}"`);
  await verifyChangeKnowledge(page, info, 'pr-knowledge-high-after-low');
});

test('opens the selected provider’s saved PR lesson when both providers used the same depth', async ({ desktop: { page, directory } }) => {
  createExplorerFixture(directory);
  await mapFixture(page, 'https://github.com/contour/dispatch', directory, true);
  await page.getByRole('option', { name: new RegExp(prTitle) }).click();
  await page.getByLabel('Reading depth').selectOption('medium');
  const codex = 'Codex explains the retry budget.';
  const claude = 'Claude explains how delivery retries work.';
  const transcript = page.getByLabel('Lesson transcript');
  const teach = page.getByRole('button', { name: 'Teach me this change', exact: true });
  const explanation = page.getByRole('tabpanel', { name: 'Explanation' });
  const provider = explanation.getByRole('group', { name: 'Brief provider' });
  const back = page.getByRole('button', { name: '← Back to change brief' });

  writeExplanation(directory, { what: codex });
  await teach.click();
  await expect(transcript).toContainText(codex);
  await back.click();
  await explanation.getByText('Provider · Codex', { exact: true }).click();
  await provider.getByRole('button', { name: /Claude Code/ }).click();
  writeExplanation(directory, { what: claude });
  await teach.click();
  await expect(transcript).toContainText(claude);
  await back.click();
  await explanation.getByText('Provider · Claude Code', { exact: true }).click();
  await provider.getByRole('button', { name: /Codex/ }).click();
  await expect(explanation).toContainText(codex);
  await teach.click();
  await expect(transcript).toContainText(codex);
  await expect(transcript).not.toContainText(claude);
});

test('draws a low-depth trace once with arrows and discloses technical text at high depth', async ({ desktop: { page, directory } }, info) => {
  createExplorerFixture(directory);
  await page.setViewportSize({ width: 1280, height: 850 });
  await mapFixture(page, 'https://github.com/contour/dispatch', directory, true);
  await page.getByRole('option', { name: new RegExp(prTitle) }).click();
  await page.getByLabel('Reading depth').selectOption('low');
  const summary = 'The worker retries a failed delivery in dispatch.ts.';
  const trace = ['Try the delivery.', 'Wait for a reply.', 'Retry after a temporary failure.'] as const;
  const technical = { ...newConcept, title: 'Retry budget in dispatch.ts', summary };
  writeExplanation(directory, { summary, trace, concepts: [concept, technical], foundations: [reviewFoundations[0]] });
  await page.getByRole('button', { name: 'Teach me this change' }).click();
  await page.getByRole('button', { name: 'Skip questions' }).click();
  await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible();
  await expect(page.getByText(/Foundation lesson/)).toHaveCount(0);
  await evidence(page, info, 'after-pr-skip');
  await page.getByRole('button', { name: '← Back to change brief' }).click();
  const diagram = page.getByLabel('Change brief').getByRole('figure', { name: 'Diagram' });
  const steps = diagram.getByRole('list', { name: 'Steps in order' });
  await expect(steps.getByRole('listitem')).toHaveText(trace);
  await expect(diagram.getByText(trace[1], { exact: true })).toHaveCount(1);
  await expect(diagram.getByRole('list', { name: 'Connections' })).toHaveCount(0);
  await expect(diagram.locator('.lesson-diagram-direct')).toHaveCount(2);
  expect(await diagram.locator('.lesson-diagram-direct').first().evaluate(node => getComputedStyle(node, '::after').borderRightWidth)).toBe('1px');
  await diagram.screenshot({ path: info.outputPath('after-diagram.png') });

  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByLabel('Learning depth').selectOption('high');
  await page.getByRole('button', { name: 'Find a concept' }).click();
  await page.getByRole('searchbox', { name: 'Search' }).fill('Retry budget in dispatch.ts');
  await page.getByLabel('Matching concepts').getByRole('button', { name: 'Retry budget', exact: true }).click();
  const guide = page.getByLabel('Concept guide');
  await expect(guide.getByRole('heading', { name: 'Retry budget', exact: true })).toBeVisible();
  await expect(guide.getByText(summary, { exact: true })).toBeHidden();
  await guide.screenshot({ path: info.outputPath('after-knowledge-card.png') });
  await guide.getByText('Technical details', { exact: true }).click();
  await expect(guide.getByText(summary, { exact: true })).toBeVisible();
});

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
  await expect(page.getByRole('region', { name: 'Selected change' })).toContainText('Choose a change');
  await expect(commits.first()).toContainText('Merge delivery retries');
  await commits.first().click();
  await page.getByLabel('Search history').fill('no such change exists');
  await page.getByRole('option', { name: /Merge delivery retries/ }).evaluateAll(rows => {
    for (const row of rows) (row as HTMLElement).click();
  });
  await expect(page.getByRole('region', { name: 'Selected change' })).toContainText('Choose a change');
  await expect(page.getByText('No changes match these filters.', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected change' })).toContainText('Choose a change');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  writeFileSync(fixture, JSON.stringify({ ...response, signedOut: true }));
  await page.getByRole('button', { name: /^refresh/i }).first().click();
  await expect(page.getByText(/run gh auth login/i).first()).toBeVisible();
  await page.getByRole('option', { name: /Retry a failed dispatch/ }).click();
  await expect(await openTab(page, 'Files changed')).toContainText('+  const attempts = 3;');
});

test('selects the row under the pointer after scrolling deep into history', async ({ desktop }) => {
  const { directory, page } = desktop;
  const { path } = createExplorerFixture(directory);
  await mapFixture(page, path, directory);
  const timeline = page.locator('#change-timeline');
  for (let i = 0; i < 10; i++) {
    const height = await timeline.evaluate(element => element.scrollHeight);
    if (height > 11500) break;
    await page.getByRole('button', { name: 'Load more changes' }).click();
    await expect.poll(() => timeline.evaluate(element => element.scrollHeight)).toBeGreaterThan(height);
  }
  await page.getByLabel('Search history').focus();
  await timeline.scrollIntoViewIfNeeded();
  await timeline.evaluate(element => { element.scrollTop = 10917; });
  const row = page.getByRole('option', { name: /Record dispatch sample 47\b/ });
  await expect(row).toBeInViewport();
  const before = await timeline.evaluate(element => element.scrollTop);
  await row.click();
  await expect(page.getByRole('region', { name: 'Selected change' }).getByRole('heading', { name: 'Record dispatch sample 47' })).toBeVisible();
  expect(await timeline.evaluate(element => element.scrollTop)).toBe(before);
  await timeline.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Selected change' }).getByRole('heading', { name: 'Record dispatch sample 46' })).toBeVisible();
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
