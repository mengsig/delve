const aliases = new Map([
  ['tcp', 'tcp'], ['transmission control protocol', 'tcp'], ['tcp transmission control protocol', 'tcp'],
  ['http', 'http'], ['hypertext transfer protocol', 'http'],
  ['hashing', 'hashing'], ['hash functions', 'hashing'],
  ['queues', 'queues'], ['queue', 'queues'], ['message queues', 'message-queues'], ['message queue', 'message-queues'],
  ['react state', 'react-state'], ['sql joins', 'sql-joins'], ['sql join', 'sql-joins'],
]);

export function normalizedConceptName(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function portableAlias(key: string, title: string): string | undefined {
  return aliases.get(normalizedConceptName(key)) ?? aliases.get(normalizedConceptName(title));
}

export const portableKeyGuide = 'For common foundations use these canonical keys: ' + [...new Set(aliases.values())].join(', ') + '.';
