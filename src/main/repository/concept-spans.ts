import type { ConceptSpan, DiffSpan } from '../../shared/change-diff';
import { coversChangedLines, patchLines } from '../../shared/change-diff';
import { DomainError } from '../../shared/errors';

export function bindConceptSpans(
  spans: readonly (DiffSpan & { key: string })[],
  patches: readonly { path: string; patch: string }[],
  touched: ReadonlyMap<string, number>,
): ConceptSpan[] {
  if (spans.length === 0) return [];
  const lines = new Map(patches.map(file => [file.path, patchLines(file.patch)]));
  return spans.map(({ key, ...span }) => {
    const conceptId = touched.get(key);
    if (conceptId === undefined) throw new DomainError('INVALID_PROPOSAL', 'A diff link names a concept outside the change footprint. Retry the request.');
    const rows = lines.get(span.path);
    if (!rows || !coversChangedLines(rows, span)) {
      throw new DomainError('INVALID_PROPOSAL', 'A concept link falls outside the approved changed lines. Retry the request.');
    }
    return { ...span, conceptId };
  });
}
