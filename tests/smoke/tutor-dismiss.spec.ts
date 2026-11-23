import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { openDatabase } from '../../src/main/db/connection';
import { test } from './desktop';

const notice = 'A saved tutor request could not be read and was skipped.';

function saveUnreadableJob(directory: string): void {
  const db = openDatabase(join(directory, 'delve.sqlite'));
  try {
    const result = db.prepare(`INSERT INTO tutor_jobs (id, workspace_id, concept_id, depth, token, detail, phase)
      SELECT ?, workspace_id, concept_id, 'low', ?, '{}', 'running'
      FROM workspace_concepts ORDER BY workspace_id, concept_id LIMIT 1`).run(randomUUID(), 'a'.repeat(64));
    expect(result.changes).toBe(1);
  } finally {
    db.close();
  }
}

test('refreshes and dismisses an unreadable tutor request across launches', async ({ desktop }, info) => {
  saveUnreadableJob(desktop.directory);
  const page = await desktop.restart();
  const activity = page.getByRole('region', { name: 'Tutor activity' });
  const unreadable = activity.getByRole('listitem').filter({ hasText: notice });
  const dismiss = unreadable.getByRole('button', { name: 'Dismiss' });
  await expect(dismiss).toBeEnabled();
  await activity.screenshot({ path: info.outputPath('unreadable-after.png') });

  const db = openDatabase(join(desktop.directory, 'delve.sqlite'));
  try {
    expect(db.prepare(`UPDATE tutor_jobs SET detail = '{"title":"Still unreadable"}'`).run().changes).toBe(1);
  } finally {
    db.close();
  }
  await dismiss.click();
  await expect(activity.getByRole('alert').filter({ hasText: 'already changed' })).toBeVisible();
  await dismiss.click();
  await expect(activity).toHaveCount(0);

  const restarted = await desktop.restart();
  await expect(restarted.getByRole('button', { name: 'Open lesson →' })).toBeVisible();
  await expect(restarted.getByText(notice)).toHaveCount(0);
});
