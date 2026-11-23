const aliases = new Map([
  ['tcp', 'tcp'], ['transmission control protocol', 'tcp'], ['tcp transmission control protocol', 'tcp'],
  ['http', 'http'], ['hypertext transfer protocol', 'http'],
  ['hashing', 'hashing'], ['hash functions', 'hashing'],
  ['queues', 'queues'], ['queue', 'queues'], ['message queues', 'message-queues'], ['message queue', 'message-queues'],
  ['react state', 'react-state'], ['sql joins', 'sql-joins'], ['sql join', 'sql-joins'],
]);

type PortableAlias = string | null | undefined;

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
