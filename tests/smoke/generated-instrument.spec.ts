import { expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from './desktop';
import { hostilePrograms } from '../fixtures/instruments/containment';

test.use({ tutorCli: true });
const routeLab = { type: 'environment', fallback: 'Connect the client to the proxy, then the proxy to the service.',
  pack: 'network-builder@1', config: null };
const prose = { type: 'prose', heading: 'A simulated path', text: 'Build the path and trace its two hops.' };

function response(directory: string, block: object) {
  writeFileSync(join(directory, 'reply.json'), JSON.stringify({
    lesson: { schema: 'delve.lesson/1', source: null, blocks: [prose, block] },
    assessment: null, observation: null, recommendation: null,
  }));
}

async function createTopic(page: Page) {
  await page.getByRole('button', { name: '+ Add', exact: true }).click();
  await page.getByRole('button', { name: 'Any topic', exact: true }).click();
  await page.getByLabel('Any topic', { exact: true }).fill('Routing workshop');
  await page.getByRole('button', { name: 'Add to atlas →' }).click();
  await page.getByRole('button', { name: 'Start a topic lesson →' }).click();
  await page.getByRole('button', { name: 'Start lesson', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Allow and continue' }).click();
}

function bundle(source: string) {
  return { type: 'environment', pack: null, fallback: 'Advance the token one square at a time.',
    config: { pack: 'bundle@1', bundle: { apiVersion: 'delve.view/1', entry: 'step', source },
      parameters: { title: 'Token board', initial: '2' } } };
}

const boardSource = `let position = 0;
function step(initial, action) {
  position = action === '' ? Number(initial) : position + 1;
  return {text: 'Token at square ' + position, controls: [{id:'advance', label:'Move token'}],
    marks:[{x:position*5,y:30,width:5,height:10,color:'#d8f879'}]};
}`;

test('a new topic wires a network, then opens a generated board inside a tutor reply', async ({ desktop: { page, directory } }) => {
  response(directory, routeLab);
  await createTopic(page);
  const stage = page.frameLocator('.instrument-frame');
  await stage.getByRole('button', { name: /client\.out/ }).click();
  await stage.getByRole('button', { name: /proxy\.in/ }).press('Enter');
  await expect(stage.getByRole('list')).toContainText('client.out → proxy.in');
  await stage.getByRole('button', { name: /proxy\.out/ }).click();
  await stage.getByRole('button', { name: /service\.in/ }).press('Enter');
  await stage.getByRole('button', { name: 'Test path' }).click();
  await expect(page.getByRole('log')).toContainText('reached the service through the proxy');
  response(directory, bundle(boardSource));
  await page.getByRole('textbox', { name: 'Ask your tutor' }).fill('Show the idea on a board');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.getByRole('dialog');
  await expect(preview).toContainText('The simulated request reached the service through the proxy.');
  await preview.getByRole('button', { name: 'Allow and continue' }).click();
  const board = page.getByRole('log').frameLocator('.instrument-frame');
  await expect(board.getByRole('status')).toHaveText('Token at square 2');
  await board.getByRole('button', { name: 'Move token' }).click();
  await expect(board.getByRole('status')).toHaveText('Token at square 3');
  await expect(page.locator('iframe')).toHaveCount(1);
});

test('terminates a looping bundle, retains the text alternative and collects no evidence', async ({ desktop: { page, directory } }) => {
  test.setTimeout(15_000);
  response(directory, bundle(`function step() { ${hostilePrograms.loop} }`));
  await createTopic(page);
  await expect(page.getByText(/Instrument unavailable\./)).toBeVisible({ timeout: 6000 });
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.locator('#instrument details p')).toBeVisible();
  await expect(page.locator('#instrument details')).toContainText('Advance the token');
  await expect(page.getByRole('complementary')).toContainText('No evidence recorded');
  await expect(page.getByRole('log').locator('.reader-message')).toHaveCount(0);
});
