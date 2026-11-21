import { expect } from '@playwright/test';
import { join } from 'node:path';
import { openDatabase } from '../../src/main/db/connection';
import { addWorkspace } from '../../src/main/db/workspaces';
import { test } from './desktop';

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

test('renders and pans 2000 concepts and 5000 edges within budget', async ({ desktop: { page, directory } }) => {
  seedLargeGraph(directory);
  const started = Date.now();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  const canvas = page.locator('.knowledge-map canvas');
  await expect.poll(() => canvas.evaluate(element => {
    const image = element as HTMLCanvasElement;
    return image.getContext('2d')!.getImageData(0, 0, image.width, image.height).data.some((value, index) => index % 4 === 3 && value > 0);
  })).toBe(true);
  expect(Date.now() - started).toBeLessThan(5000);
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 100, box!.y + 100);
  await page.mouse.down();
  const panStarted = Date.now();
  await page.mouse.move(box!.x + 140, box!.y + 120);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.mouse.up();
  expect(Date.now() - panStarted).toBeLessThan(1000);
});
