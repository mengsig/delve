import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import { OBJECT_ID } from './source-policy';

const TREE = Buffer.from('tree ');
const PARENT = Buffer.from('parent ');

export function commitParentHeaders(content: Buffer, commit: string, truncated = false) {
  assert.ok(Buffer.isBuffer(content));
  assert.ok(OBJECT_ID.test(commit));
  const treeEnd = TREE.length + commit.length + 1;
  const parentBytes = PARENT.length + commit.length + 1;
  if (content.length < treeEnd && truncated) return null;
  if (!content.subarray(0, TREE.length).equals(TREE) || content[treeEnd - 1] !== 10
    || !OBJECT_ID.test(content.toString('latin1', TREE.length, treeEnd - 1).toLowerCase())) {
    throw new DomainError('SOURCE_READ_FAILED', 'Git returned an invalid commit tree header.');
  }

  const parents: string[] = [];
  let parentsEnd = treeEnd;
  // Git stops at the first non-parent header, even if later headers start with "parent ".
  while (parentsEnd + parentBytes <= content.length && content.subarray(parentsEnd, parentsEnd + PARENT.length).equals(PARENT)) {
    const newline = parentsEnd + parentBytes - 1;
    const parent = content.toString('latin1', parentsEnd + PARENT.length, newline).toLowerCase();
    if (content[newline] !== 10 || !OBJECT_ID.test(parent)) {
      throw new DomainError('SOURCE_READ_FAILED', 'Git returned an invalid commit parent header.');
    }
    parents.push(parent);
    parentsEnd += parentBytes;
  }

  const next = content.subarray(parentsEnd, parentsEnd + PARENT.length);
  if (truncated && next.equals(PARENT.subarray(0, next.length))) return null;
  return { parents, treeEnd, parentsEnd };
}
