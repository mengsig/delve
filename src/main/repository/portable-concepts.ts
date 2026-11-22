import assert from 'node:assert/strict';
import { getConceptByKey, type Concept } from '../db/concepts';
import type { Db } from '../db/connection';
import { normalizedConceptName, portableAlias } from '../db/portable-identity';

export function portableConceptLookup(db: Db) {
  const rows = db.prepare("SELECT key, title FROM concepts WHERE portable = 1 AND key NOT LIKE 'Demo:%' ORDER BY id").all();
  const byTitle = new Map<string, string | null>();
  const byAlias = new Map<string, string>();
  for (const { key, title } of rows) {
    assert.ok(typeof key === 'string' && key.length > 0);
    assert.ok(typeof title === 'string' && title.length > 0);
    const name = normalizedConceptName(title);
    byTitle.set(name, byTitle.has(name) ? null : key);
    const alias = portableAlias(key, title);
    if (alias && (!byAlias.has(alias) || key === alias)) byAlias.set(alias, key);
  }
  return (key: string, title: string): { key: string; concept: Concept | null } => {
    const name = normalizedConceptName(title);
    const alias = portableAlias(key, title);
    const stableKey = (alias && byAlias.get(alias)) ?? alias ?? key;
    const existing = getConceptByKey(db, stableKey);
    if (existing) return { key: existing.key, concept: existing };
    const titleKey = byTitle.get(name);
    if (!titleKey) {
      if (!byTitle.has(name)) byTitle.set(name, stableKey);
      return { key: stableKey, concept: null };
    }
    return { key: titleKey, concept: getConceptByKey(db, titleKey) };
  };
}
