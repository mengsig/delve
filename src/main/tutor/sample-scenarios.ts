import assert from 'node:assert/strict';
import type { Depth } from '../../shared/domain';
import { freshCheckSchema } from '../reader/document';
import type { PreparedTurn } from './prompt';
import { photographyScenarios } from './sample-photography';
import { systemsScenarios } from './sample-systems';

export type Scenario = readonly [
  setup: string,
  question: string,
  choices: readonly [answer: string, string, string, string],
  explanation: string,
];
export type ScenarioBank = Record<string, Record<Depth, readonly [Scenario, Scenario, ...Scenario[]]>>;

const scenarios: ScenarioBank = { ...systemsScenarios, ...photographyScenarios };
const openingWords = ([setup]: Scenario) => setup.split('{')[0]!;

// Consecutive values express related facts such as a deadline and the following tick.
const render = (template: string, base: number) =>
  template.replace(/\{(\d+)\}/g, (_, offset: string) => String(base + Number(offset)));

export function scenarioFeedback(id: string, depth: Depth, prompt: string) {
  return scenarios[id]?.[depth].find(scenario => prompt.startsWith(openingWords(scenario)))?.[3];
}

export function transferCase(id: string, turn: PreparedTurn, workedExample = false) {
  const { context, mastery } = turn;
  const cases = scenarios[id]?.[context.depth];
  assert.ok(cases && cases.length >= 2, 'each demo concept needs transfer cases at each depth');
  const openings = cases.map(openingWords);
  assert.equal(new Set(openings).size, cases.length, 'identify case families by distinct openings');
  const ranked = cases.map((scenario, index) => ({
    scenario, lastSeen: mastery.prompts.findLastIndex(prompt => prompt.startsWith(openings[index]!)),
  })).sort((left, right) => left.lastSeen - right.lastSeen);
  const [setup, question, options, explanation] = ranked[workedExample ? 1 : 0]!.scenario;
  assert.ok(explanation.trim() && /\{\d+\}/.test(setup), 'each case needs feedback and a variable fact');
  const base = 10 + 10 * mastery.prompts.length;
  const shift = mastery.prompts.length % options.length;
  const order = options.slice(shift).concat(options.slice(0, shift));
  const check = freshCheckSchema.parse({ type: 'check', kind: 'prediction',
    prompt: render(setup + ' ' + question, base), options: order.map(option => render(option, base)),
    expected: (options.length - shift) % options.length });
  return { check, explanation };
}
