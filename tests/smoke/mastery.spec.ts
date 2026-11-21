import { expect, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from './desktop';
import { withinBudget } from './action-budget';

test.use({ tutorCli: true, firstRun: true });

const concepts = [
  { key: 'agents', title: 'Agents, tasks, and runs', summary: 'Agents do work on tasks; a run groups the root agent and its descendants.', portable: false },
  { key: 'permissions', title: 'Permissions and isolation', summary: 'Permissions limit what agents can do.', portable: false },
];
const explanation = { type: 'prose', heading: 'Three building blocks', text: 'A task is an objective. Agents do the work. A run groups the root agent and its descendants.' };
const openingCheck = { type: 'check', kind: 'choice', prompt: 'What groups the workers?', options: ['The task objective', 'The run'], expected: 1 };
const firstCheck = { type: 'check', kind: 'short-answer', prompt: 'A root agent starts a helper. What groups them, and why?', expected: ['The run groups the root and helper agents.'] };
const secondCheck = { type: 'check', kind: 'short-answer', prompt: 'A team must fix a bug. Which part is the objective and which parts do the work?', expected: ['The task is the objective; agents do the work.'] };

function reply(directory: string, blocks: object[], assessment: boolean | null = null, observation: string | null = null) {
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ lesson: { schema: 'delve.lesson/1', source: null, blocks },
    assessment, observation, recommendation: null }));
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

async function completeNextLesson(page: Page, directory: string) {
  await page.getByRole('button', { name: 'Start lesson', exact: true }).click();
  await expect(page.getByRole('heading', { name: openingCheck.prompt })).toBeVisible();
  reply(directory, [explanation, secondCheck], true, 'That is right.');
  await page.getByRole('button', { name: 'The run', exact: true }).click();
  await expect(page.getByRole('heading', { name: secondCheck.prompt })).toBeVisible();
  reply(directory, [{ type: 'prose', heading: 'Exactly', text: 'The task states the goal; the agents work toward it.' }], true, 'That is right.');
  await page.getByRole('textbox', { name: secondCheck.prompt }).fill('The task is the objective; agents do the work.');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  const complete = page.getByRole('region', { name: 'Lesson complete' });
  await expect(complete).toContainText('You understand this concept');
  await capture(page, complete, 'completion-after');
  await withinBudget(page, 'Go back to the prerequisite lesson', 1, async () => {
    await complete.getByRole('button', { name: 'Go back to Agents, tasks, and runs' }).click();
    await expect(page.getByRole('heading', { name: 'Agents, tasks, and runs', level: 1 })).toBeVisible();
  });
}

test('guides a learner from a misconception to completion and a one-click next lesson', async ({ desktop }) => {
  const { page, directory } = desktop;
  mkdirSync('.archon/evidence', { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  const repo = repository(directory);
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ schema: 'delve.map/1', concepts,
    edges: [{ concept: 'permissions', prerequisite: 'agents' }], recommendation: { key: 'agents', reason: 'Start with the building blocks.' } }));
  await page.locator('#source-input').fill(repo);
  await page.getByRole('button', { name: 'Add and build map' }).click();
  await expect(page.getByLabel('Field guide')).toContainText('Agents, tasks, and runs');
  await page.getByRole('region', { name: 'Repository generation' }).getByRole('button', { name: 'Dismiss' }).click();
  reply(directory, [explanation, openingCheck]);
  await page.getByLabel('Field guide').getByRole('button', { name: /Agents, tasks, and runs/ }).click();
  await page.getByRole('button', { name: 'Start lesson', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Always allow for this workspace' }).click();
  await expect(page.getByRole('heading', { name: openingCheck.prompt })).toBeVisible();
  await expect(page.getByText('Suggested next step')).toHaveCount(0);
  await capture(page, page.getByRole('heading', { name: explanation.heading }), 'mastery-explain');
  await capture(page, page.locator('#checkpoint'), 'mastery-check');

  reply(directory, [{ type: 'prose', heading: 'Look at the roles', text: 'The task is the objective, not the group of workers. The run groups the root agent and its descendants.' }, firstCheck], false, 'That is not right.');
  await page.getByRole('button', { name: 'The task objective', exact: true }).click();
  await expect(page.getByRole('heading', { name: firstCheck.prompt })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('not right');
  await expect(page.getByRole('log')).toContainText('task is the objective');
  await capture(page, page.getByRole('log').getByText('Look at the roles'), 'mastery-reinforce');

  reply(directory, [{ type: 'prose', heading: 'The relationships', text: 'Use this picture to remember the roles.' },
    { type: 'diagram', nodes: ['Run', 'Agent', 'Task', 'Agent'], edges: [{ from: 0, to: 1, label: 'groups' }, { from: 0, to: 3, label: 'groups' }, { from: 1, to: 2, label: 'works on' }] }]);
  await page.getByRole('textbox', { name: 'Ask your tutor' }).fill('Can you create a nice visual for me to remember this?');
  await page.getByRole('button', { name: 'Ask question' }).click();
  await expect(page.getByRole('log')).toContainText('The relationships');
  await capture(page, page.getByRole('log').getByText('The relationships'), 'mastery-visual');

  reply(directory, [{ type: 'prose', heading: 'That grouping works', text: 'The run includes both agents.' }, secondCheck], true, 'That is right.');
  await page.getByRole('textbox', { name: firstCheck.prompt }).fill('The run groups the root and helper agents.');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('heading', { name: secondCheck.prompt })).toBeVisible();
  await capture(page, page.locator('#checkpoint'), 'mastery-applied');

  reply(directory, [{ type: 'prose', heading: 'Exactly', text: 'The task states the goal; the agents work toward it.' }], true, 'That is right.');
  await page.getByRole('textbox', { name: secondCheck.prompt }).fill('The task is the objective; agents do the work.');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  const complete = page.getByRole('region', { name: 'Lesson complete' });
  await expect(complete).toContainText('You understand this concept');
  await expect(complete).toContainText('Permissions and isolation');
  await expect(complete.getByRole('button', { name: /^Go back to / })).toHaveCount(0);
  await capture(page, complete, 'mastery-complete');
  reply(directory, [explanation, openingCheck]);
  await withinBudget(page, 'Move to the next lesson', 1, async () => {
    await complete.getByRole('button', { name: 'Next lesson: Permissions and isolation' }).click();
    await expect(page.getByRole('heading', { name: 'Permissions and isolation', level: 1 })).toBeVisible();
  });
  await completeNextLesson(page, directory);
});


test('keeps practice primary after a skipped check', async ({ desktop: { page, directory } }) => {
  mkdirSync('.archon/evidence', { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  const repo = repository(directory);
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ schema: 'delve.map/1', concepts,
    edges: [{ concept: 'permissions', prerequisite: 'agents' }], recommendation: { key: 'agents', reason: 'Start here.' } }));
  await page.locator('#source-input').fill(repo);
  await page.getByRole('button', { name: 'Add and build map' }).click();
  await expect(page.getByLabel('Field guide')).toContainText('Agents, tasks, and runs');
  await page.getByRole('region', { name: 'Repository generation' }).getByRole('button', { name: 'Dismiss' }).click();
  reply(directory, [explanation, openingCheck]);
  await page.getByLabel('Field guide').getByRole('button', { name: /Agents, tasks, and runs/ }).click();
  await page.getByRole('button', { name: 'Start lesson', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Always allow for this workspace' }).click();
  await expect(page.getByRole('heading', { name: openingCheck.prompt })).toBeVisible();
  await page.getByRole('button', { name: 'Skip this check' }).click();
  const complete = page.getByRole('region', { name: 'Lesson complete' });
  await expect(complete).toContainText('Not understood yet');
  await expect(complete).toContainText('not marked understood');
  await expect(complete.getByRole('button', { name: /Next lesson/ })).toHaveCount(0);
  await expect(complete).not.toContainText('Recommended next');
  await expect(complete.getByRole('button', { name: 'Keep practising' })).toHaveClass(/primary-btn/);
  await expect(complete.getByRole('button', { name: 'Move on anyway: Permissions and isolation' })).toBeVisible();
  await capture(page, complete, 'skip-after');
  reply(directory, [explanation, firstCheck]);
  await complete.getByRole('button', { name: 'Keep practising' }).click();
  await expect(page.getByRole('heading', { name: firstCheck.prompt })).toBeVisible();
  await page.getByRole('button', { name: 'Skip this check' }).click();
  await complete.getByRole('button', { name: 'Move on anyway: Permissions and isolation' }).click();
  await expect(page.getByRole('heading', { name: 'Permissions and isolation', level: 1 })).toBeVisible();
});
