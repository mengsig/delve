import { expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openDatabase } from '../../src/main/db/connection';
import { addWorkspace } from '../../src/main/db/workspaces';
import { test } from './desktop';

const nativePointer = process.env.KNOWLEDGE_NATIVE_POINTER === '1';
const xdotool = promisify(execFile);

function seedLargeGraph(directory: string) {
  const db = openDatabase(join(directory, 'delve.sqlite'));
  const workspace = addWorkspace(db, { kind: 'topic', title: 'Large graph' });
  const insert = db.prepare('INSERT INTO concepts (key, title, portable, created_at, updated_at) VALUES (?, ?, 1, ?, ?)');
  const member = db.prepare('INSERT INTO workspace_concepts (workspace_id, concept_id) VALUES (?, ?)');
  const edge = db.prepare('INSERT INTO concept_edges (concept_id, prerequisite_id, created_at) VALUES (?, ?, ?)');
  const ids: number[] = [];
  db.exec('BEGIN');
  for (let index = 0; index < 2000; index += 1) {
    const id = Number(insert.run(`large-${index}`, `Concept ${index}`, 'now', 'now').lastInsertRowid);
    ids.push(id); member.run(workspace.id, id);
  }
  let count = 0;
  for (let index = 3; index < ids.length && count < 5000; index += 1) {
    for (let offset = 1; offset <= 3 && count < 5000; offset += 1, count += 1) edge.run(ids[index]!, ids[index - offset]!, 'now');
  }
  db.exec('COMMIT'); db.close();
  expect(ids).toHaveLength(2000); expect(count).toBe(5000);
}

async function measureFrames(page: Page, action: () => Promise<void>) {
  await page.evaluate(() => {
    const samples: number[] = [];
    let previous = performance.now();
    let running = true;
    function frame() {
      const now = performance.now();
      samples.push(now - previous);
      previous = now;
      if (running) requestAnimationFrame(frame);
    }
    (window as unknown as { stopFrames: () => number[] }).stopFrames = () => { running = false; return samples; };
    requestAnimationFrame(frame);
  });
  await action();
  const samples = await page.evaluate(() => (window as unknown as { stopFrames: () => number[] }).stopFrames());
  samples.shift();
  expect(samples.length).toBeGreaterThan(10);
  samples.sort((a, b) => a - b);
  return { frames: samples.length, p95: samples[Math.floor(samples.length * .95)], max: samples.at(-1) };
}

async function measureInteraction(page: Page, x: number, y: number, offset: { x: number; y: number }) {
  const move = async (x: number, y: number) => {
    if (nativePointer) await xdotool('xdotool', ['mousemove', String(Math.round(x + offset.x)), String(Math.round(y + offset.y))]);
    else await page.mouse.move(x, y);
  };
  await move(x, y);
  if (nativePointer) await page.waitForTimeout(100);
  if (nativePointer) await xdotool('xdotool', ['mousedown', '1']);
  else await page.mouse.down();
  const pan = await measureFrames(page, async () => {
    const start = Date.now();
    while (Date.now() - start < 2000) {
      const progress = (Date.now() - start) / 2000;
      await move(x + 200 * progress, y + 80 * progress);
      await new Promise(resolve => setTimeout(resolve, 16));
    }
  });
  if (nativePointer) await xdotool('xdotool', ['mouseup', '1']);
  else await page.mouse.up();
  const zoom = await measureFrames(page, async () => {
    for (let index = 0; index < 12; index += 1) {
      if (nativePointer) await xdotool('xdotool', ['click', index < 6 ? '4' : '5']);
      else await page.mouse.wheel(0, index < 6 ? -50 : 50);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  });
  return { pan, zoom };
}

test('renders and pans 2000 concepts and 5000 edges within budget', async ({ desktop: { page, directory, application } }) => {
  seedLargeGraph(directory);
  const started = Date.now();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  const canvas = page.locator('.knowledge-map canvas');
  await expect.poll(() => canvas.evaluate(element => {
    const image = element as HTMLCanvasElement;
    return image.getContext('2d')!.getImageData(0, 0, image.width, image.height).data.some((value, index) => index % 4 === 3 && value > 0);
  })).toBe(true);
  expect(Date.now() - started).toBeLessThan(5000);
  await page.waitForTimeout(1000);
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const offset = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds());
  const x = box!.x + 100; const y = box!.y + 100;
  if (nativePointer) {
    await xdotool('xdotool', ['mousemove', String(Math.round(x + offset.x)), String(Math.round(y + offset.y)), 'click', '1']);
    await page.waitForTimeout(300);
  }
  const initialView = await page.evaluate(() => localStorage.getItem('delve.knowledge.viewport'));
  await canvas.evaluate(element => {
    const counts = { downs: 0, moves: 0, wheels: 0 };
    (window as unknown as { graphInputCounts: typeof counts }).graphInputCounts = counts;
    element.addEventListener('pointerdown', () => { counts.downs += 1; });
    element.addEventListener('pointermove', event => { if ((event as PointerEvent).buttons) counts.moves += 1; });
    element.addEventListener('wheel', () => { counts.wheels += 1; });
  });
  const { pan, zoom } = await measureInteraction(page, x, y, offset);
  const inputs = await page.evaluate(() => (window as unknown as { graphInputCounts: { downs: number; moves: number; wheels: number } }).graphInputCounts);
  console.log('Knowledge input events:', JSON.stringify(inputs));
  expect(inputs.downs).toBe(1);
  expect(inputs.moves).toBeGreaterThan(10);
  expect(inputs.wheels).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('delve.knowledge.viewport'))).not.toBe(initialView);
  console.log('Knowledge frame timing (ms):', JSON.stringify({ pan, zoom }));
  const strictBudget = process.env.KNOWLEDGE_FRAME_BUDGET === '1';
  if (strictBudget || process.env.CI) {
    for (const [interaction, timing] of Object.entries({ pan, zoom })) {
      expect(timing.p95, `${interaction} p95 frame gap (ms)`).toBeLessThan(strictBudget ? 33 : 100);
      expect(timing.max, `${interaction} maximum frame gap (ms)`).toBeLessThan(strictBudget ? 50 : 250);
    }
  }
});
