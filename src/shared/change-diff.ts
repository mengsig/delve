export interface DiffSpan {
  path: string;
  side: 'old' | 'new';
  start: number;
  end: number;
}

export interface ConceptSpan extends DiffSpan {
  conceptId: number;
}

export interface DiffLine {
  kind: 'hunk' | 'addition' | 'deletion' | 'context' | 'metadata';
  text: string;
  oldLine?: number;
  newLine?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function patchLines(patch: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const text of patch.replace(/\n$/, '').split('\n')) {
    const header = HUNK.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      rows.push({ kind: 'hunk', text });
    } else if (inHunk && text.startsWith('+')) {
      rows.push({ kind: 'addition', newLine: newLine++, text });
    } else if (inHunk && text.startsWith('-')) {
      rows.push({ kind: 'deletion', oldLine: oldLine++, text });
    } else if (inHunk && text.startsWith(' ')) {
      rows.push({ kind: 'context', oldLine: oldLine++, newLine: newLine++, text });
    } else if (text && (inHunk || !/^(?:diff --git |index |--- |\+\+\+ )/.test(text))) {
      rows.push({ kind: 'metadata', text });
    }
  }
  return rows;
}

export function coversChangedLines(rows: DiffLine[], span: DiffSpan): boolean {
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 1 || span.end < span.start) return false;
  const kind = span.side === 'old' ? 'deletion' : 'addition';
  const field = span.side === 'old' ? 'oldLine' : 'newLine';
  let expected = span.start;
  for (const row of rows) {
    if (row.kind === kind && row[field] === expected) {
      if (expected === span.end) return true;
      expected++;
    } else if (expected > span.start) {
      return false;
    }
  }
  return false;
}
