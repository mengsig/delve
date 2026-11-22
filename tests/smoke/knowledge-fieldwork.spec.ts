import { expect, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, transaction } from '../../src/main/db/connection';
import { addWorkspace } from '../../src/main/db/workspaces';
import { addPrerequisite, upsertConcept, upsertConceptInTransaction } from '../../src/main/db/concepts';
import { recordEvidence } from '../../src/main/db/evidence';
import { saveLesson } from '../../src/main/db/lessons';
import { withinBudget } from './action-budget';
import { shortcut, test } from './desktop';

test.use({ tutorCli: true });
const opening = { type: 'prose', heading: 'Claim a task', text: 'A lease gives one worker temporary ownership.' };
const check = { type: 'check', kind: 'prediction', prompt: 'Which worker owns the task?', options: ['The first worker', 'The current lease holder', 'Both', 'Neither'], expected: 1 };

function seedArea(directory: string, cached = true) {
  const db = openDatabase(join(directory, 'delve.sqlite'));
  const workspace = addWorkspace(db, { kind: 'topic', title: 'Task processing' });
  const concepts = [
    ['queue', 'Durable queue', 'Keep a task available until a worker can take it.'],
    ['clock', 'Lease clock', 'Time limits let another worker take over.'],
    ['lease', 'Worker leases', 'Decide whose result is safe to commit when a task changes hands.'],
    ['fence', 'Write fencing', 'Prevent an expired owner from committing a late result.'],
    ['journal', 'Event journal', 'Keep a durable record of each step.'],
    ['recovery', 'Recovery', 'Resume work after an interruption.'],
  ].map(([key, title, summary]) => upsertConcept(db, { key: 'fieldwork-' + key, title: title!, summary: summary!, portable: true, workspaceId: workspace.id }));
  const [queue, clock, lease, fence, journal, recovery] = concepts;
  for (const [from, to] of [[queue, lease], [clock, lease], [lease, fence], [queue, journal], [fence, recovery], [journal, recovery]]) {
    addPrerequisite(db, to!.id, from!.id);
  }
  for (const concept of [queue!, clock!]) {
    recordEvidence(db, { conceptId: concept.id, depth: 'medium', status: 'demonstrated', source: 'check', masteryVerified: true, workspaceId: workspace.id });
  }
  if (cached) saveLesson(db, { workspaceId: workspace.id, depth: 'medium', conceptId: lease!.id,
    cacheKey: 'fieldwork-opening', provider: 'codex', model: 'fixture', schemaVersion: 'delve.lesson/1',
    body: { schema: 'delve.lesson/1', blocks: [opening, check] } });
  db.close();
  return workspace;
}

async function captureArea(page: Page, prefix: string) {
  mkdirSync('.archon/evidence', { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ path: '.archon/evidence/' + prefix + '-' + theme + '.png' });
  }
}

test('shows a guided learning area', async ({ desktop }) => {
  seedArea(desktop.directory);
  const page = await desktop.restart();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page.locator('.knowledge-map canvas')).toBeVisible();
  await expect.poll(() => page.locator('.knowledge-map canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data.some((n, i) => i % 4 === 3 && n > 0);
  })).toBe(true);
  await expect(page.getByRole('meter', { name: 'Concepts mastered' })).toHaveJSProperty('value', 2);
  const start = page.getByRole('button', { name: 'Start Worker leases' });
  await expect(start).toBeInViewport({ ratio: 1 });
  await expect(start).toBeEnabled();
  await expect(page.locator('.knowledge-detail')).toContainText('You already understand Durable queue and Lease clock.');
  await captureArea(page, 'after');
  await withinBudget(page, 'Start the suggested saved lesson', 1, async () => {
    await start.click();
    await expect(page.getByRole('heading', { name: opening.heading })).toBeVisible();
  });
  await page.getByRole('button', { name: /Back to Knowledge/i }).click();
  await expect(page.locator('.knowledge-detail h3').first()).toHaveText('Worker leases');
  await page.getByRole('button', { name: 'Find a concept' }).click();
  await page.getByLabel('Search', { exact: true }).fill('missing concept');
  await expect(page.getByRole('heading', { name: 'No matching concepts' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).first().click();
  await page.getByRole('combobox', { name: 'State', exact: true }).selectOption('locked');
  await expect(page.getByRole('heading', { name: 'No eligible next lesson' })).toBeVisible();
  await page.getByRole('button', { name: 'Write fencing', exact: true }).click();
  await expect(page.locator('.knowledge-detail')).toContainText('Learn Worker leases first.');
  await expect(page.getByRole('button', { name: 'Explore this lesson' })).toBeEnabled();
});

test('one inline grant starts a fresh lesson in its area and Back restores the original view', async ({ desktop: { page, directory } }) => {
  const workspace = seedArea(directory, false);
  const origin = await page.locator('#active-workspace').textContent();
  expect(origin).toBeTruthy();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByLabel('Workspace area').selectOption(workspace.id);
  await page.getByRole('button', { name: 'Find a concept' }).click();
  await page.getByLabel('Search', { exact: true }).fill('leases');
  const stored = () => page.evaluate(() => localStorage.getItem('delve.knowledge.viewport'));
  const scale = async () => JSON.parse(await stored() ?? '{}').scale;
  await expect.poll(scale).toBe(1);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(scale).toBeCloseTo(1.2);
  const start = page.getByRole('button', { name: 'Allow once & start Worker leases' });
  await expect(start).toBeEnabled();
  await page.getByText('Exact request', { exact: true }).click();
  const request = await page.getByLabel('Exact provider request').innerText();
  await page.getByText('Exact request', { exact: true }).click();
  const camera = await stored();
  const receipt = join(directory, 'request.json');
  expect(existsSync(receipt)).toBe(false);
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({ observation: null, assessment: null, recommendation: null,
    lesson: { schema: 'delve.lesson/1', source: null, blocks: [opening, check] } }));
  await withinBudget(page, 'Grant and start the next lesson across workspaces', 1, async () => {
    await start.click();
    await expect(page.getByRole('heading', { name: opening.heading })).toBeVisible();
  });
  expect(JSON.parse(readFileSync(receipt, 'utf8')).stdin).toBe(request);
  await expect(page.locator('#active-workspace')).toContainText('Task processing');
  await expect(page.getByLabel('Reading depth')).toHaveValue('medium');
  await page.getByRole('button', { name: /Back to Knowledge/i }).click();
  await expect(page.locator('#active-workspace')).toHaveText(origin!);
  await expect(page.getByLabel('Search', { exact: true })).toHaveValue('leases');
  await expect(page.getByLabel('Workspace area')).toHaveValue(workspace.id);
  await expect(page.locator('.knowledge-detail h3').first()).toHaveText('Worker leases');
  await expect.poll(stored).toBe(camera);
});

function masteredMarker(page: Page) {
  return page.locator('.knowledge-map canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d')!;
    const swatch = document.createElement('canvas').getContext('2d')!;
    swatch.fillStyle = getComputedStyle(canvas).getPropertyValue('--mastery-fill');
    swatch.fillRect(0, 0, 1, 1);
    const [r, g, b] = swatch.getImageData(0, 0, 1, 1).data;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const rect = canvas.getBoundingClientRect();
    for (let pixel = 0; pixel < data.length; pixel += 4) {
      if (data[pixel] === r && data[pixel + 1] === g && data[pixel + 2] === b && data[pixel + 3] === 255) {
        const index = pixel / 4;
        return { x: rect.x + (index % canvas.width) * rect.width / canvas.width,
          y: rect.y + Math.floor(index / canvas.width) * rect.height / canvas.height };
      }
    }
    return null;
  });
}

test('previews a painted marker, pins its guide and explores by keyboard', async ({ desktop }) => {
  seedArea(desktop.directory);
  const page = await desktop.restart();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  const guide = page.getByLabel('Concept guide');
  const canvas = page.locator('.knowledge-map canvas');
  await expect.poll(() => masteredMarker(page)).toBeTruthy();
  const marker = (await masteredMarker(page))!;
  await page.mouse.move(marker.x, marker.y);
  const tip = page.locator('.knowledge-map-tip');
  await expect(tip).toContainText('Mastered');
  const title = await tip.locator('strong').innerText();
  await expect(guide.getByRole('heading', { name: 'Worker leases' })).toBeVisible();
  await page.mouse.click(marker.x, marker.y);
  await expect(guide.getByRole('heading', { name: title })).toBeVisible();
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  const neighbor = await tip.locator('strong').innerText();
  expect(neighbor).not.toBe(title);
  await page.keyboard.press('Enter');
  await expect(guide.getByRole('heading', { name: neighbor })).toBeVisible();
  await guide.getByRole('button', { name: 'Focus neighbourhood' }).click();
  await expect(guide.getByRole('button', { name: 'Show all connections' })).toBeVisible();
  await page.getByRole('button', { name: 'Fit map' }).click();
  await guide.getByRole('button', { name: 'Show in workspace Atlas' }).click();
  await expect(page.getByRole('button', { name: /Back to Knowledge/i })).toBeVisible();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(guide.getByRole('heading', { name: neighbor })).toBeVisible();
  await expect(guide.getByRole('button', { name: 'Show all connections' })).toBeVisible();
});

test('completes the reviewed path and opens the exact change-only concept in Atlas', async ({ desktop: { directory, page } }) => {
  const workspace = seedArea(directory);
  const db = openDatabase(join(directory, 'delve.sqlite'));
  const ids = db.prepare('SELECT concept_id FROM workspace_concepts WHERE workspace_id = ?').all(workspace.id);
  for (const row of ids) recordEvidence(db, { conceptId: Number(row.concept_id), workspaceId: workspace.id,
    depth: 'low', status: 'demonstrated', source: 'check', masteryVerified: true });
  const extra = transaction(db, () => upsertConceptInTransaction(db, { key: 'change-only', title: 'Lease renewal',
    workspaceId: workspace.id, portable: false }, false));
  db.close();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByLabel('Workspace area').selectOption(workspace.id);
  await page.getByLabel('Learning depth').selectOption('low');
  await expect(page.getByRole('heading', { name: 'Path mastered' })).toBeVisible();
  await expect(page.getByRole('meter', { name: 'Concepts mastered' })).toHaveJSProperty('value', ids.length);
  await page.getByRole('button', { name: 'View progress' }).click();
  await expect(page.locator('#active-workspace')).toContainText(workspace.name);
  await expect(page.locator('.windowbar').getByRole('meter', { name: 'Workspace mastery · low depth' })).toBeVisible();
  await page.getByRole('button', { name: /Back to Knowledge/i }).click();
  await expect(page.getByRole('heading', { name: 'Path mastered' })).toBeVisible();
  await expect(page.getByLabel('Workspace area')).toHaveValue(workspace.id);
  await expect(page.getByRole('meter', { name: 'Concepts mastered' })).toHaveJSProperty('max', ids.length);
  await page.getByRole('button', { name: 'Find a concept' }).click();
  await page.getByRole('button', { name: extra.title, exact: true }).click();
  await page.getByRole('button', { name: 'Show in workspace Atlas' }).click();
  await expect(page.getByLabel('Selected concept')).toContainText(extra.title);
  await expect(page.getByText('Viewing a concept from Knowledge alongside your reviewed map.')).toBeVisible();
  await page.getByRole('button', { name: 'Return to reviewed map' }).click();
  await expect(page.getByLabel('Selected concept')).not.toContainText(extra.title);
  await page.getByRole('button', { name: /Back to Knowledge/i }).click();
  await expect(page.getByLabel('Concept guide').getByRole('heading', { name: extra.title })).toBeVisible();
});

test('serializes header and keyboard navigation while a Knowledge workspace switch is pending', async ({ desktop }) => {
  const { page, application } = desktop;
  const workspace = seedArea(desktop.directory);
  const identity = page.locator('#active-workspace strong');
  const origin = await identity.innerText();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByLabel('Workspace area').selectOption(workspace.id);
  const atlas = page.locator('.windowbar').getByRole('button', { name: 'Atlas', exact: true });
  // Hold real switch replies in the isolated Electron fixture so input can arrive during the round trip.
  const release = await application.evaluateHandle(({ ipcMain }) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, request: unknown) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const original = handlers.get('workspaces:switch');
    if (!original) throw new Error('The desktop workspace switch handler must be installed.');
    let resume: (() => void) | undefined;
    ipcMain.removeHandler('workspaces:switch');
    ipcMain.handle('workspaces:switch', async (event, request) => {
      const result = await original(event, request);
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 4000);
        resume = () => { clearTimeout(timer); resolve(); };
      });
      return result;
    });
    return () => resume?.();
  });
  async function tryOtherDestinations(trigger: Locator, source: Locator) {
    const bounds = await atlas.boundingBox();
    if (!bounds) throw new Error('The Atlas header button must be visible.');
    await trigger.click();
    await expect(page.getByText('Opening workspace…')).toBeVisible({ timeout: 2000 });
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.keyboard.press(shortcut);
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.getByRole('combobox', { name: /Search workspaces/ })).toHaveCount(0);
    await expect(source).toBeVisible({ timeout: 1000 });
    await release.evaluate(resume => resume());
  }
  try {
    await tryOtherDestinations(page.getByRole('button', { name: 'Start Worker leases' }), page.locator('.knowledge'));
    await expect(page.getByRole('heading', { name: opening.heading })).toBeVisible();
    await expect(page.locator('#active-workspace')).toContainText(workspace.name);
    await tryOtherDestinations(page.getByRole('button', { name: /Back to Knowledge/i }), page.getByText(opening.heading, { exact: true }).first());
    await expect(identity).toHaveText(origin);
    await expect(page.getByLabel('Workspace area')).toHaveValue(workspace.id);
    await expect(page.getByLabel('Concept guide')).toContainText('Worker leases');
  } finally {
    await release.evaluate(resume => resume());
    await release.dispose();
  }
});
