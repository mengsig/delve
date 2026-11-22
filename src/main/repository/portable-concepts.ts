import assert from 'node:assert/strict';
import { getConceptByKey, type Concept } from '../db/concepts';
import type { Db } from '../db/connection';

const aliases = new Map([
  ['tcp', 'tcp'], ['transmission control protocol', 'tcp'], ['tcp transmission control protocol', 'tcp'],
  ['http', 'http'], ['hypertext transfer protocol', 'http'],
  ['hashing', 'hashing'], ['hash functions', 'hashing'],
  ['queues', 'queues'], ['queue', 'queues'], ['message queues', 'message-queues'], ['message queue', 'message-queues'],
  ['react state', 'react-state'], ['sql joins', 'sql-joins'], ['sql join', 'sql-joins'],
]);

function normalized(text: string): string {
  return text.normalize('NFKC').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export const portableKeyGuide = 'For common foundations use these canonical keys: tcp, http, hashing, queues, message-queues, react-state, sql-joins.';

export function portableConceptLookup(db: Db) {
  const rows = db.prepare("SELECT key, title FROM concepts WHERE portable = 1 AND key NOT LIKE 'Demo:%' ORDER BY id").all();
  const byTitle = new Map<string, string | null>();
  const byAlias = new Map<string, string>();
  for (const { key, title } of rows) {
    assert.ok(typeof key === 'string' && key.length > 0);
    assert.ok(typeof title === 'string' && title.length > 0);
    const name = normalized(title);
    byTitle.set(name, byTitle.has(name) ? null : key);
    const alias = aliases.get(normalized(key)) ?? aliases.get(name);
    if (alias && (!byAlias.has(alias) || key === alias)) byAlias.set(alias, key);
  }
  return (key: string, title: string): { key: string; concept: Concept | null } => {
    const name = normalized(title);
    const alias = aliases.get(normalized(key)) ?? aliases.get(name);
    const stableKey = (alias && byAlias.get(alias)) ?? alias ?? key;
    const existing = getConceptByKey(db, key) ?? getConceptByKey(db, stableKey);
    if (existing) return { key: existing.key, concept: existing };
    const titleKey = byTitle.get(name);
    if (!titleKey) {
      if (!byTitle.has(name)) byTitle.set(name, stableKey);
      return { key: stableKey, concept: null };
    }
    return { key: titleKey, concept: getConceptByKey(db, titleKey) };
  };
}
