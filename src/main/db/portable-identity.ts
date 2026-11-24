import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const aliases = new Map([
  ['tcp', 'tcp'], ['transmission control protocol', 'tcp'], ['tcp transmission control protocol', 'tcp'],
  ['http', 'http'], ['hypertext transfer protocol', 'http'],
  ['hashing', 'hashing'], ['hash functions', 'hashing'],
  ['queues', 'queues'], ['queue', 'queues'], ['message queues', 'message-queues'], ['message queue', 'message-queues'],
  ['react state', 'react-state'], ['sql joins', 'sql-joins'], ['sql join', 'sql-joins'],
]);

type PortableAlias = string | null | undefined;
export type ConceptMeaning = { key: string; title: string; summary: string };

export function normalizedConceptName(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

export function portableAlias(key: string, title: string): PortableAlias {
  const lookup = (value: string) => aliases.get(normalizedConceptName(value).replace(/[()_-]+/g, ' ').trim().replace(/\s+/g, ' '));
  const keyAlias = lookup(key);
  const titleAlias = lookup(title);
  // Null marks contradictory aliases. Undefined means there is no recognized alias.
  if (keyAlias && titleAlias && keyAlias !== titleAlias) return null;
  return keyAlias ?? titleAlias;
}

export function compatiblePortableAliases(left: PortableAlias, right: PortableAlias): boolean {
  return left !== null && right !== null && (left === undefined || right === undefined || left === right);
}

export const portableKeyGuide = 'For common foundations use these canonical keys: ' + [...new Set(aliases.values())].join(', ') + '.';

// The similarity threshold is 100% after Unicode, case and whitespace normalization.
export function compatibleDescriptions(left: string, right: string): boolean {
  const first = normalizedConceptName(left);
  const second = normalizedConceptName(right);
  return first.length > 0 && first === second;
}

export function compatibleConceptMeanings(left: ConceptMeaning, right: ConceptMeaning): boolean {
  return compatibleDescriptions(left.summary, right.summary)
    && compatiblePortableAliases(portableAlias(left.key, left.title), portableAlias(right.key, right.title));
}

export function compatibleScopedMeanings(input: ConceptMeaning, saved: ConceptMeaning): boolean {
  assert.ok(input.key);
  assert.ok(saved.key);
  if (compatibleConceptMeanings(input, saved)) return true;
  return input.key === saved.key && portableAlias(input.key, input.title) === null
    && normalizedConceptName(input.title) === normalizedConceptName(saved.title)
    && compatibleDescriptions(input.summary, saved.summary);
}

export function baselineConceptFingerprint(input: ConceptMeaning & { portable: boolean }): string {
  assert.ok(input.key && input.summary.trim());
  assert.ok(input.title.trim());
  const key = input.portable ? portableAlias(input.key, '') ?? input.key : input.key;
  const alias = portableAlias(input.key, input.title);
  const label = alias === null ? normalizedConceptName(input.title) : alias;
  return digestIdentity(['baseline', key, normalizedConceptName(input.summary), label]);
}

export function releasedScopedFingerprint(input: ConceptMeaning & { portable: boolean }): string {
  const key = input.key.trim().toLowerCase();
  const alias = portableAlias(key, input.title);
  const summary = normalizedConceptName(input.summary);
  if (alias === null) {
    const keyAlias = portableAlias(key, '');
    const titleAlias = portableAlias('', input.title);
    assert.ok(keyAlias && titleAlias);
    assert.notEqual(keyAlias, titleAlias);
    return digestIdentity([keyAlias, titleAlias, summary]);
  }
  if (!input.portable && alias !== undefined) return digestIdentity([key, alias, summary]);
  return digestIdentity([alias ?? key, summary]);
}

function digestIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
