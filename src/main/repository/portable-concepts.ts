import assert from 'node:assert/strict';
import { getConceptByKey, type Concept } from '../db/concepts';
import type { Db } from '../db/connection';
import { compatibleConceptMeanings, normalizedConceptName, portableAlias, type ConceptMeaning } from '../db/portable-identity';

export function portableConceptLookup(db: Db) {
  const rows = db.prepare("SELECT key, title FROM concepts WHERE portable = 1 AND key NOT LIKE 'Demo:%' ORDER BY id").all();
  const byAlias = new Map<string, string[]>();
  const titles = new Set<string>();
  const pending = new Map<string, ConceptMeaning>();
  for (const { key, title } of rows) {
    assert.ok(typeof key === 'string' && key.length > 0);
    assert.ok(typeof title === 'string' && title.length > 0);
    titles.add(normalizedConceptName(title));
    const alias = portableAlias(key, '');
    if (alias) byAlias.set(alias, [...(byAlias.get(alias) ?? []), key]);
  }
  return (key: string, title: string, summary: string): { key: string; concept: Concept | null; portable: boolean } => {
    const normalizedKey = key.trim().toLowerCase();
    const alias = portableAlias(normalizedKey, '');
    const label = portableAlias(normalizedKey, title);
    if (label === null) return { key: normalizedKey, concept: null, portable: false };
    const meaning = { key: normalizedKey, title, summary };
    const keys = new Set([normalizedKey, ...(alias ? byAlias.get(alias) ?? [] : [])]);
    const candidates = [...keys].map(candidate => getConceptByKey(db, candidate)).filter((c): c is Concept => c !== null);
    const pendingKeys = [...keys].filter(candidate => pending.has(candidate) && !candidates.some(concept => concept.key === candidate));
    const [pendingKey] = pendingKeys;
    if (pendingKey) {
      const candidate = pending.get(pendingKey);
      assert.ok(candidate);
      if (pendingKeys.length === 1 && candidates.length === 0 && compatibleConceptMeanings(meaning, candidate)) {
        return { key: pendingKey, concept: null, portable: true };
      }
      return { key: normalizedKey, concept: null, portable: false };
    }
    if (candidates.length) {
      const [candidate] = candidates;
      if (candidates.length === 1 && candidate?.portable && compatibleConceptMeanings(meaning, candidate)) {
        return { key: candidate.key, concept: candidate, portable: true };
      }
      return { key: normalizedKey, concept: null, portable: false };
    }
    if (titles.has(normalizedConceptName(title))) return { key: normalizedKey, concept: null, portable: false };
    const stableKey = alias ?? normalizedKey;
    titles.add(normalizedConceptName(title));
    pending.set(stableKey, { ...meaning, key: stableKey });
    if (alias) byAlias.set(alias, [stableKey]);
    return { key: stableKey, concept: null, portable: true };
  };
}
