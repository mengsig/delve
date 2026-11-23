import assert from 'node:assert/strict';
import { getConceptByKey, type Concept } from '../db/concepts';
import type { Db } from '../db/connection';
import { compatibleDescriptions, normalizedConceptName, portableAlias } from '../db/portable-identity';

export function portableConceptLookup(db: Db) {
  const rows = db.prepare("SELECT key, title FROM concepts WHERE portable = 1 AND key NOT LIKE 'Demo:%' ORDER BY id").all();
  const byAlias = new Map<string, string[]>();
  const titles = new Set<string>();
  for (const { key, title } of rows) {
    assert.ok(typeof key === 'string' && key.length > 0);
    assert.ok(typeof title === 'string' && title.length > 0);
    titles.add(normalizedConceptName(title));
    const alias = portableAlias(key, title);
    if (alias) byAlias.set(alias, [...(byAlias.get(alias) ?? []), key]);
  }
  return (key: string, title: string, summary: string): { key: string; concept: Concept | null; portable: boolean } => {
    const normalizedKey = key.trim().toLowerCase();
    const alias = portableAlias(normalizedKey, title);
    const keys = new Set([normalizedKey, ...(alias ? byAlias.get(alias) ?? [] : [])]);
    const candidates = [...keys].map(candidate => getConceptByKey(db, candidate)).filter((c): c is Concept => c !== null);
    if (candidates.length) {
      if (candidates.length === 1 && candidates[0]!.portable && compatibleDescriptions(summary, candidates[0]!.summary)) {
        return { key: candidates[0]!.key, concept: candidates[0]!, portable: true };
      }
      return { key: normalizedKey, concept: null, portable: false };
    }
    if (titles.has(normalizedConceptName(title))) return { key: normalizedKey, concept: null, portable: false };
    const stableKey = alias ?? normalizedKey;
    titles.add(normalizedConceptName(title));
    if (alias) byAlias.set(alias, [stableKey]);
    return { key: stableKey, concept: null, portable: true };
  };
}
