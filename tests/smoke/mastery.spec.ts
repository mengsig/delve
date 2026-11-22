import { expect, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/main/db/connection';
import { upsertConcept, addPrerequisite } from '../../src/main/db/concepts';
import { addWorkspace, listWorkspaces, switchWorkspace } from '../../src/main/db/workspaces';
import { test } from './desktop';
import { withinBudget } from './action-budget';

test.use({ tutorCli: true, firstRun: true });

const concepts = [
  { key: 'agents', title: 'Agents, tasks, and runs', summary: 'Agents do work on tasks; a run groups the root agent and its descendants.', portable: false },
  { key: 'permissions', title: 'Permissions and isolation', summary: 'Permissions limit what agents can do.', portable: false },
];
const explanation = { type: 'prose', heading: 'Three building blocks', text: 'A task is an objective. Agents do the work. A run groups the root agent and its descendants.' };
const openingCheck = { type: 'check', kind: 'prediction', prompt: 'What groups the workers?', options: ['The task objective', 'The run', 'A file', 'The tool output'], expected: 1 };
const firstCheck = { type: 'check', kind: 'prediction', prompt: 'A root agent starts a helper. What groups them, and why?', options: ['The root’s ID alone', 'The run groups both agents', 'The tool output', 'Each task is a separate run'], expected: 1 };
const secondCheck = { type: 'check', kind: 'prediction', prompt: 'A team must fix a bug. Which part is the objective and which parts do the work?', options: ['The agents are the goal', 'A run is always one agent', 'The task is the goal and agents do the work', 'All tasks are tools'], expected: 2 };

function reply(directory: string, blocks: object[], assessment: boolean | null = null, observation: string | null = null, reasoningFeedback?: string) {
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ lesson: { schema: 'delve.lesson/1', source: null, blocks },
    assessment, observation, reasoningFeedback, recommendation: null }));
}

function repository(directory: string) {
  const path = join(directory, 'aether-fixture');
  mkdirSync(path);
  execFileSync('git', ['init', '--quiet', '--template=', '--initial-branch=main', path]);
  const content = 'export const lesson = "agents, tasks and runs";\n';
  const data = (value: string) => 'data ' + Buffer.byteLength(value) + '\n' + value + '\n';
  const commit = ['commit refs/heads/main', 'committer Fixture <fixture@example.invalid> 1000000000 +0000',
    data('Add concepts').trimEnd(), 'M 100644 inline concepts.ts', data(content)].join('\n');
  execFileSync('git', ['-C', path, 'fast-import', '--quiet'], { input: commit + '\ndone\n' });
  return path;
}

async function capture(page: Page, locator: Locator, name: string) {
  await locator.scrollIntoViewIfNeeded();
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ path: `.archon/evidence/${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

const consent = (page: Page) => page.getByRole('region', { name: 'Review what will be sent' });
const checkAnswer = (page: Page) => page.getByRole('button', { name: 'Check answer' });
const complete = (page: Page) => page.getByRole('region', { name: 'Lesson complete' });

async function mapRepository(page: Page, directory: string, shared = false) {
  const repo = repository(directory);
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ schema: 'delve.map/1', concepts: shared ? [{ ...concepts[0], portable: true }, concepts[1]] : concepts,
    edges: [{ concept: 'permissions', prerequisite: 'agents' }], recommendation: { key: 'agents', reason: 'Start here.' } }));
  await page.locator('#source-input').fill(repo);
  await page.getByRole('button', { name: 'Add and build map' }).click();
  await expect(page.getByLabel('Field guide')).toContainText('Agents, tasks, and runs');
  await page.getByRole('region', { name: 'Repository generation' }).getByRole('button', { name: 'Dismiss' }).click();
  reply(directory, [explanation, openingCheck]);
}

async function correctAnswer(page: Page, directory: string, choice: string, next?: typeof firstCheck) {
  reply(directory, next ? [explanation, next] : [explanation], true, 'The task describes the goal. A run groups agents doing that work.');
  await page.getByRole('button', { name: choice, exact: true }).click();
  await checkAnswer(page).click();
  await consent(page).getByRole('button', { name: 'Allow once and continue' }).click();
  if (next) await expect(page.getByRole('heading', { name: next.prompt })).toBeVisible();
  else await expect(complete(page)).toBeVisible();
}

test('counts fresh consent clicks and uses the saved choice and reason through completion', async ({ desktop: { page, directory } }) => {
  mkdirSync('.archon/evidence', { recursive: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await mapRepository(page, directory);
  await expect(page.locator('.workspace-identity small')).toHaveText('main');
  const why = 'The task objective names the group.';
  await withinBudget(page, 'Open, allow teaching, select, explain, check and allow feedback', 6, async () => {
    await page.getByLabel('Field guide').getByRole('button', { name: /Agents, tasks, and runs/ }).click();
    await consent(page).getByRole('button', { name: 'Allow once and continue' }).click();
    await page.getByRole('button', { name: 'The task objective', exact: true }).click();
    const reason = page.getByRole('textbox', { name: /Explain your reasoning/ });
    await reason.click();
    await page.keyboard.insertText(why);
    reply(directory, [explanation, firstCheck], false, 'A run identifies the group of agents.', 'The task objective names the work to be done, so it cannot identify the group.');
    await checkAnswer(page).click();
    await consent(page).getByRole('button', { name: 'Allow once and continue' }).click();
    await expect(page.getByRole('heading', { name: firstCheck.prompt })).toBeVisible();
  });
  expect(JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8')).stdin).toContain(why);
  await expect(page.getByRole('log')).toContainText(why);
  await expect(page.getByRole('log')).toContainText('A run identifies the group of agents.');
  await expect(page.getByRole('log')).toContainText('Correction');

  reply(directory, [{ type: 'prose', heading: 'The relationships', text: 'Compare the roles.' },
    { type: 'diagram', nodes: ['Run', 'Agent'], edges: [{ from: 0, to: 1, label: 'groups' }] }]);
  await page.getByRole('button', { name: 'Ask tutor', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask your tutor' }).fill('Can you draw the relationship?');
  await page.getByRole('button', { name: 'Ask question' }).click();
  await consent(page).getByRole('button', { name: 'Allow once and continue' }).click();
  await expect(page.getByRole('log')).toContainText('The relationships');
  await page.getByRole('button', { name: 'Answer check', exact: true }).click();
  await correctAnswer(page, directory, firstCheck.options[1]!, secondCheck);
  await correctAnswer(page, directory, secondCheck.options[2]!);
  await expect(complete(page)).toContainText('Agents, tasks, and runs mastered');
  await capture(page, complete(page), 'mastery-complete');
  reply(directory, [explanation, openingCheck]);
  await withinBudget(page, 'Allow and start the next lesson', 1, async () => {
    await complete(page).getByRole('button', { name: 'Allow once & start Permissions and isolation' }).click();
    await expect(page.getByRole('heading', { name: openingCheck.prompt })).toBeVisible();
  });
  await correctAnswer(page, directory, 'The run', secondCheck);
  await correctAnswer(page, directory, secondCheck.options[2]!);
  await complete(page).getByRole('button', { name: 'View progress' }).click();
  await expect(page.getByRole('heading', { name: 'Your field record.' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'aether-fixture' })).toContainText('2 / 2');
});

test('submits a fresh check in five clicks with one-time consent and empty reasoning', async ({ desktop: { page, directory } }) => {
  await mapRepository(page, directory);
  await withinBudget(page, 'Open, approve opening, choose, check, approve feedback', 5, async () => {
    await page.getByLabel('Field guide').getByRole('button', { name: /Agents, tasks, and runs/ }).click();
    await consent(page).getByRole('button', { name: 'Allow once and continue' }).click();
    await expect(page.getByRole('heading', { name: openingCheck.prompt })).toBeVisible();
    await correctAnswer(page, directory, 'The run', firstCheck);
  });
  await expect(page.getByRole('meter', { name: 'Correct checks in a row' })).toHaveJSProperty('value', 1);
});

function addSharedStudy(directory: string) {
  const db = openDatabase(join(directory, 'delve.sqlite'));
  try {
    const origin = listWorkspaces(db).activeId;
    expect(origin).toBeTruthy();
    const { id: workspaceId } = addWorkspace(db, { kind: 'topic', title: 'Distributed computing' });
    const shared = upsertConcept(db, { ...concepts[0]!, workspaceId, portable: true });
    const next = upsertConcept(db, { key: 'delegation', title: 'Delegation', workspaceId, portable: false });
    addPrerequisite(db, next.id, shared.id);
    switchWorkspace(db, origin!);
  } finally { db.close(); }
}

async function backgroundFinalAnswer(page: Page, directory: string) {
  await page.getByLabel('Field guide').getByRole('button', { name: /Agents, tasks, and runs/ }).click();
  await consent(page).getByRole('button', { name: 'Always allow for this workspace' }).click();
  await expect(page.getByRole('heading', { name: openingCheck.prompt })).toBeVisible();
  reply(directory, [explanation, firstCheck], true, 'A run groups agents working toward the objective.');
  await page.getByRole('button', { name: 'The run', exact: true }).click();
  await checkAnswer(page).click();
  await expect(page.getByRole('heading', { name: firstCheck.prompt })).toBeVisible();
  writeFileSync(join(directory, 'gate'), '');
  reply(directory, [explanation], true, 'The root and its helper belong to the same run.');
  await page.getByRole('button', { name: firstCheck.options[firstCheck.expected]!, exact: true }).click();
  await checkAnswer(page).click();
  await page.getByRole('button', { name: 'Continue in background' }).click();
}

const activeMeter = (page: Page) => page.locator('.windowbar').getByRole('meter', { name: /Workspace mastery/ });
const activity = (page: Page) => page.getByRole('region', { name: 'Tutor activity' });

test('reopening a completed background answer reads the current record after a reset', async ({ desktop: { page, directory } }) => {
  await mapRepository(page, directory);
  await backgroundFinalAnswer(page, directory);
  await page.getByRole('navigation').getByRole('button', { name: 'Progress' }).click();
  await expect(activeMeter(page)).toHaveJSProperty('value', 0);
  unlinkSync(join(directory, 'gate'));
  await expect(activeMeter(page)).toHaveJSProperty('value', 1);
  await expect(activity(page)).toContainText('Tutor response ready');
  await page.getByText(/^Inspect .* learning records$/).click();
  const record = page.getByRole('listitem').filter({ hasText: 'Agents, tasks, and runs' }).filter({ hasText: 'medium' });
  await record.getByRole('button', { name: 'Reset record' }).click();
  await record.getByRole('button', { name: 'Confirm reset' }).click();
  await expect(activeMeter(page)).toHaveJSProperty('value', 0);
  await activity(page).getByRole('button', { name: 'Open lesson' }).click();
  await expect(activity(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: openingCheck.prompt })).toBeVisible();
  await expect(page.getByRole('meter', { name: 'Correct checks in a row' })).toHaveJSProperty('value', 0);
  await expect(complete(page)).toHaveCount(0);
});

test('refreshes the visible shared learning path and all coverage rows after background mastery', async ({ desktop }) => {
  const { directory } = desktop;
  await mapRepository(desktop.page, directory, true);
  addSharedStudy(directory);
  const page = await desktop.restart();
  await backgroundFinalAnswer(page, directory);
  await page.getByRole('group', { name: 'Your workspaces' }).getByRole('button', { name: /^Distributed computing/ }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Progress' }).click();
  const path = page.getByRole('region', { name: 'Workspace learning path' });
  const coverage = page.getByRole('table');
  await expect(activeMeter(page)).toHaveJSProperty('value', 0);
  await expect(path.getByRole('meter', { name: 'Delegation' })).toHaveAttribute('aria-valuetext', 'Locked');
  unlinkSync(join(directory, 'gate'));
  await expect(activity(page)).toContainText('Tutor response ready');
  await expect(activeMeter(page)).toHaveJSProperty('value', 1);
  await expect(path.getByRole('meter', { name: 'Agents, tasks, and runs' })).toHaveJSProperty('value', 2);
  await expect(path.getByRole('meter', { name: 'Delegation' })).toHaveAttribute('aria-valuetext', 'Ready');
  for (const workspace of ['aether-fixture', 'Distributed computing']) {
    await expect(coverage.getByRole('meter', { name: workspace + ' · medium depth' })).toHaveJSProperty('value', 1);
  }
});

test('keeps practice primary after a skipped check', async ({ desktop: { page, directory } }) => {
  await mapRepository(page, directory);
  await page.getByLabel('Field guide').getByRole('button', { name: /Agents, tasks, and runs/ }).click();
  await consent(page).getByRole('button', { name: 'Always allow for this workspace' }).click();
  await expect(page.getByRole('heading', { name: openingCheck.prompt })).toBeVisible();
  await page.getByRole('button', { name: 'Lesson notes' }).click();
  await page.getByRole('button', { name: 'Skip this check' }).click();
  const paused = page.getByRole('region', { name: 'Practice paused' });
  await expect(paused).toContainText('You skipped this check.');
  await expect(complete(page)).toHaveCount(0);
  await expect(paused.getByRole('button', { name: 'Keep practising' })).toHaveClass(/primary-btn/);
  reply(directory, [explanation, firstCheck]);
  await paused.getByRole('button', { name: 'Keep practising' }).click();
  await expect(page.getByRole('heading', { name: firstCheck.prompt })).toBeVisible();
  await page.getByRole('button', { name: 'Lesson notes' }).click();
  await page.getByRole('button', { name: 'Skip this check' }).click();
  await paused.getByRole('button', { name: 'Move on anyway: Permissions and isolation' }).click();
  await expect(page.getByRole('heading', { name: 'Permissions and isolation', level: 1 })).toBeVisible();
});
