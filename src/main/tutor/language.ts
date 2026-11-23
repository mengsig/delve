import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import type { Document } from '../reader/document';

export const depthGuide = {
  high: 'Write like a colleague explaining this to a non-specialist. Use short sentences and everyday words. Say what changed and why it matters to a person, with one concrete analogy or worked example. If a technical term is necessary, define it in one short plain sentence when it first appears. Keep code, identifiers, file names, internal fields, and source or CI caveats out of the teaching and feedback.',
  medium: 'Explain how the parts interact at the module or technique level.',
  low: 'Walk through the important code changes and boundary conditions. When a diff is supplied, quote short relevant excerpts from it and name the affected files and functions. Connect the code to what it does. For non-code topics, work through the exact technique.',
} as const;

type Block = Document['blocks'][number];

function visibleText(block: Block): string[] {
  switch (block.type) {
    case 'prose': case 'analogy': case 'callout': return [block.heading, block.text];
    case 'example': return [block.heading, block.setup, ...block.steps, block.takeaway];
    case 'comparison': return 'rows' in block
      ? [block.heading, ...block.columns, ...block.rows.flat()]
      : [block.heading, block.before, block.after];
    case 'trace': return block.steps;
    case 'diagram': return [...block.nodes, ...(block.edges ?? []).flatMap(edge => edge.label ? [edge.label] : [])];
    case 'environment': return block.fallback ? [block.fallback] : [];
    case 'check': return [block.prompt, ...(block.options ?? [])];
    case 'code': return [];
    case 'unknown': return [];
  }
}

const technicalText = /(?:`[^`]+`|\b[a-z_$][\w$]*[A-Z][\w$]*\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[\w-]+\.(?:ts|tsx|js|jsx|py|rs|json|ya?ml|md|toml|go|java|css|html)\b|\b(?:function|class|const|let|var)\s+[\w$]+\s*[=(]|(?:=>|\b\w+\([^)]*\)))/;
const metaCaveat = /\b(?:i|we) (?:cannot|can't|could not|couldn't|did not|didn't|haven't|have not|unable to) (?:access|inspect|read|see|verify|check|run|view)\b|\b(?:source (?:code|files?)|repository|repo|files?|ci|tests?) (?:was|were|is|are) not (?:available|provided|accessible|run|checked|inspected|verified)\b|\b(?:(?:supplied|provided|available) diff|partial (?:diff|coverage)|benchmark (?:harness|verdict)|ci retr(?:y|ies))\b/i;

function textIssue(text: string): string | null {
  assert.equal(typeof text, 'string', 'learner-facing text must be a string');
  if (technicalText.test(text)) return 'Learner-facing text contains code, an identifier or a file name.';
  if (metaCaveat.test(text)) return 'Learner-facing text contains a source or CI caveat.';
  const sentences = text.split(/(?<=[.!?])\s+/u);
  assert.ok(sentences.length > 0, 'splitting text preserves at least one sentence');
  if (sentences.some(sentence => (sentence.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length > 30)) {
    return 'Learner-facing text contains a sentence longer than 30 words.';
  }
  return null;
}

export function highDepthIssue(lesson: Document, feedback: readonly string[] = []): string | null {
  assert.ok(Array.isArray(lesson.blocks), 'a lesson must contain blocks');
  for (const block of lesson.blocks) {
    if (block.type === 'code') return 'A high-depth lesson contains a code block.';
    const issue = highDepthTextIssue(visibleText(block));
    if (issue) return issue;
  }
  return highDepthTextIssue(feedback);
}

export function highDepthTextIssue(texts: readonly string[]): string | null {
  assert.ok(Array.isArray(texts), 'learner-facing text must be supplied as a list');
  for (const text of texts) {
    const issue = textIssue(text);
    if (issue) return issue;
  }
  return null;
}

export async function withPlainLanguageRetry<T>(generate: () => Promise<T>, issue: (reply: T) => string | null): Promise<T> {
  const first = await generate();
  if (issue(first) === null) return first;
  const second = await generate();
  const problem = issue(second);
  if (problem) throw new DomainError('UNREADABLE_TUTOR_REPLY', problem + ' Retry to get a plain-language explanation.');
  return second;
}

const partialReasoning = /\b(?:partly right|partially correct|not quite right|not entirely correct|not fully correct|misconception|(?:your (?:reasoning|explanation|argument|rule)|that reasoning) (?:is |was )?(?:incorrect|wrong|mistaken|flawed|needs? (?:a |an )?(?:correction|adjustment)))\b/i;

function feedbackSentences(text: string): string[] {
  const trimmed = text.trim();
  const content = trimmed.replace(/^(?:right|partly right|not quite)(?:\s*[—–:,-]\s*|[.!?]\s*)/i, '');
  return (content || trimmed).split(/(?<=[.!?])\s+/u).map(sentence => sentence.trim()).filter(Boolean);
}

export function formatAnswerFeedback(correct: boolean, observation: string, reasoningFeedback?: string): string {
  assert.equal(typeof correct, 'boolean', 'the choice result must be boolean');
  assert.ok(observation.trim(), 'answer feedback needs an observation');
  const reasoning = reasoningFeedback?.trim() ?? '';
  const verdict = correct ? (reasoning && partialReasoning.test(reasoning) ? 'Partly right' : 'Right') : 'Not quite';
  const observationParts = feedbackSentences(observation);
  const reasoningParts = feedbackSentences(reasoning);
  const parts = reasoningParts.length ? [...observationParts.slice(0, 2), reasoningParts[0]] : observationParts.slice(0, 3);
  assert.ok(parts.length > 0, 'answer feedback needs learner-facing content');
  return `${verdict} — ${parts.join(' ')}`;
}
