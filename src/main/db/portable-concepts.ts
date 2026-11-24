import assert from 'node:assert/strict';
import { getConceptByKey, type Concept } from './concepts';
import type { Db } from './connection';
import { compatibleConceptMeanings, portableAlias, type ConceptMeaning } from './portable-identity';

export function findPortableConcept(db: Db, input: ConceptMeaning): Concept | null {
  assert.ok(input.key && input.summary.trim());
  assert.ok(input.title.trim());
  const exact = getConceptByKey(db, input.key);
  if (exact) return exact.portable && compatibleConceptMeanings(input, exact) ? exact : null;
  const alias = portableAlias(input.key, '');
  if (!alias || portableAlias(input.key, input.title) === null) return null;
  let matchedKey: string | undefined;
  for (const { key } of db.prepare("SELECT key FROM concepts WHERE portable = 1 AND key NOT LIKE 'Demo:%'").iterate()) {
    assert.ok(typeof key === 'string' && key);
    if (portableAlias(key, '') !== alias) continue;
    if (matchedKey) return null;
    matchedKey = key;
  }
  if (!matchedKey) return null;
  const saved = getConceptByKey(db, matchedKey);
  assert.ok(saved?.portable);
  return compatibleConceptMeanings(input, saved) ? saved : null;
}
