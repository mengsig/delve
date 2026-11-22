import assert from 'node:assert/strict';
import { demoMaterial } from '../reader/demo';
import { freshCheckSchema } from '../reader/document';
import { transferCase } from './sample-scenarios';
import type { PreparedTurn } from './prompt';

const scenarioShape = (prompt: string) => prompt.replace(/\d+/g, '#');

function leaseCases(claim: number) {
  return [
    [`B takes over with claim ${claim}. A reports first. Which result can the writer accept?`,
      'The first result to arrive', 'The current lease holder’s result', 'Both results, in arrival order', 'The one with the older timestamp', 1],
    [`A late result carries claim ${claim - 1}. Claim ${claim} is active. What should happen?`,
      'Wait for both workers', 'Save the older result', 'Reject the outdated claim', 'Accept the first arrival', 2],
    [`A write and a reassignment to claim ${claim} race in storage. What should the write check atomically?`,
      'The job name and worker hostname', 'That no result has arrived earlier', 'The time when the worker began', 'That the claim matches the active generation', 3],
    [`The owner of claim ${claim} stops responding and the claim expires. What can happen before that worker reports back?`,
      'A replacement can take over under a newer generation', 'The old worker’s result is committed automatically',
      'The job is removed as complete', 'The dispatcher must wait for the old worker’s permission', 0],
  ] as const;
}

function exposureCases(speed: number) {
  return [
    [`At 1/${speed} s the rider still blurs. Which change limits recorded movement at fixed aperture?`,
      'Increase ISO and keep the shutter time', 'Shorten the shutter time', 'Lengthen the exposure', 'Crop more tightly afterward', 1],
    [`A 1/${speed * 2} s exposure gives a sharp but dark rider. Which change brightens the result at fixed aperture without adding motion blur?`,
      'Lengthen exposure and lower ISO', 'Keep the settings and crop in', 'Raise ISO at the same shutter time', 'Shorten the shutter time again', 2],
    [`Two photos use 1/${speed} s at the same aperture. The second uses a higher ISO. What happens to the motion trails?`,
      'They get shorter', 'They get longer', 'They double in length', 'They stay the same length', 3],
    [`The scene gets brighter while the rider’s speed stays fixed. Which change at 1/${speed} s lowers recorded brightness and keeps motion blur unchanged?`,
      'Lower ISO and keep the shutter time', 'Lengthen the exposure', 'Raise ISO and keep the shutter time', 'Shorten the exposure', 0],
    [`The exposure starts at 1/${speed} s and ISO 200. At fixed aperture, which ISO offsets the brightness change at 1/${speed * 4} s?`,
      'ISO 100', 'ISO 400', 'ISO 800', 'ISO 1600', 2],
  ] as const;
}

export function demoCheck(turn: PreparedTurn, position: number, cycle: number, focus?: string) {
  const { context, mastery } = turn;
  assert.ok(Number.isSafeInteger(position) && position >= 0 && position <= mastery.maxAttempts);
  assert.ok(Number.isSafeInteger(cycle) && cycle >= 0);
  const { id } = demoMaterial(context.key);
  // Leave room for all attempts and a replacement of the current check in each round.
  const caseId = 20 + cycle * 32 + mastery.prompts.length;
  if (id === 'lease' || id === 'exposure') {
    const cases = id === 'lease' ? leaseCases(caseId) : exposureCases(100 + caseId * 10);
    const next = (position + cycle + cases.length - 1) % cases.length;
    const byDepth = id === 'lease' ? { high: 3, medium: 0, low: 2 } : { high: 0, medium: 1, low: 4 };
    const transfer = focus === 'arrival' || focus === 'shutter' ? 1 : focus === 'claim' ? 0 : next;
    const preferred = turn.request.intent.kind === 'adapt' ? byDepth[context.depth] : transfer;
    const current = mastery.check?.prompt ?? '';
    const index = scenarioShape(cases[preferred]![0]) === scenarioShape(current)
      ? (preferred + 2) % cases.length : preferred;
    const [prompt, first, second, third, fourth, expected] = cases[index]!;
    return freshCheckSchema.parse({ type: 'check', kind: 'prediction', prompt, options: [first, second, third, fourth], expected });
  }
  return transferCase(id, turn).check;
}
