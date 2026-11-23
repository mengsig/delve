import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addPrerequisite, upsertConcept, upsertConceptInTransaction } from './concepts';
import { openDatabase, transaction, type Db } from './connection';
import { seedDemoWorkspaces } from './demo';
import { readWorkspaceGraph } from './graph';
import { persistTutorPrerequisites } from './tutor-prerequisites';
import { addWorkspace } from './workspaces';

let db: Db;
let workspace: string;
let other: string;
const candidate = (key: string, title = key) => ({ key, title, summary: `Summary ${title}` });

beforeEach(() => {
  db = openDatabase(':memory:');
  workspace = addWorkspace(db, { kind: 'topic', title: 'First' }).id;
  other = addWorkspace(db, { kind: 'topic', title: 'Other' }).id;
});
afterEach(() => db.close());

describe('tutor prerequisites', () => {
  it('reuses local and portable concepts without changing their text, and deduplicates', () => {
    const target = upsertConcept(db, { key: 'target', title: 'Target', portable: false, workspaceId: workspace });
    const local = upsertConcept(db, { key: 'local', title: '  Shared Name ', summary: 'Existing local', portable: false, workspaceId: workspace });
    upsertConcept(db, { key: 'shared', title: 'Shared Name', portable: true, workspaceId: other });
    const portable = upsertConcept(db, { key: 'portable', title: 'Portable', summary: 'Existing portable', portable: true, workspaceId: other });
    upsertConcept(db, { key: 'private', title: 'Private', portable: false, workspaceId: other });
    const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [
      candidate('new-key', 'shared   name'), candidate('local', 'Changed'), candidate('portable', 'Changed'), candidate('private', 'Private'),
    ]));
    expect(result.map(item => [item.concept.id, item.candidateKey])).toEqual([[local.id, 'new-key'], [portable.id, 'portable'], [expect.any(Number), 'private']]);
    expect(result[0]!.concept.summary).toBe('Existing local');
    expect(result[1]!.concept.summary).toBe('Existing portable');
    expect(result[2]!.concept.portable).toBe(true);
    expect(readWorkspaceGraph(db, workspace).edges).toHaveLength(3);
  });

  it('omits self and cycles without leaking membership and preserves valid siblings', () => {
    const target = upsertConcept(db, { key: 'target', title: 'Target', portable: false, workspaceId: workspace });
    const cycle = upsertConcept(db, { key: 'cycle', title: 'Cycle', portable: false, workspaceId: workspace });
    addPrerequisite(db, cycle.id, target.id);
    db.prepare('DELETE FROM workspace_concepts WHERE workspace_id = ? AND concept_id = ?').run(workspace, cycle.id);
    const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('target', 'Target'), candidate('cycle', 'Cycle'), candidate('valid', 'Valid')]));
    expect(result.map(row => row.candidateKey)).toEqual(['valid']);
    expect(readWorkspaceGraph(db, workspace).concepts.map(c => c.id)).not.toContain(cycle.id);
    expect(readWorkspaceGraph(db, workspace).edges).toEqual([{ conceptId: target.id, prerequisiteId: result[0]!.concept.id }]);
  });

  it('orders direct and transitive dependencies before dependents while keeping ready candidates stable', () => {
    const target = upsertConcept(db, { key: 'target', title: 'Target', portable: true, workspaceId: workspace });
    const a = upsertConcept(db, { key: 'a', title: 'A', portable: true });
    const b = upsertConcept(db, { key: 'b', title: 'B', portable: true });
    const intermediate = upsertConcept(db, { key: 'intermediate', title: 'Intermediate', portable: true });
    const c = upsertConcept(db, { key: 'c', title: 'C', portable: true });
    addPrerequisite(db, a.id, intermediate.id);
    addPrerequisite(db, intermediate.id, c.id);
    const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('a'), candidate('b'), candidate('c')]));
    expect(result.map(row => row.concept.id)).toEqual([b.id, c.id, a.id]);
  });

  it('keeps hidden change targets hidden while promoting prerequisites', () => {
    const target = transaction(db, () => upsertConceptInTransaction(db, { key: 'change', title: 'Change', portable: false, workspaceId: workspace }, false));
    const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('foundation')]));
    expect(readWorkspaceGraph(db, workspace).concepts.map(c => c.id)).toEqual([result[0]!.concept.id]);
    expect(readWorkspaceGraph(db, workspace, true).edges).toEqual([{ conceptId: target.id, prerequisiteId: result[0]!.concept.id }]);
  });

  it('does not reuse legacy aliases or local concepts for portable targets', () => {
    const target = upsertConcept(db, { key: 'target', title: 'Target', portable: true, workspaceId: workspace });
    const legacy = upsertConcept(db, { key: 'old', title: 'Foundation', portable: false, workspaceId: workspace });
    const canonical = upsertConcept(db, { key: 'canonical', title: 'Foundation', portable: true });
    db.prepare('INSERT INTO concept_identity_links (legacy_concept_id, canonical_concept_id) VALUES (?, ?)').run(legacy.id, canonical.id);
    const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('old', 'Foundation')]));
    expect(result.map(row => row.concept.id)).toEqual([canonical.id]);
    expect(readWorkspaceGraph(db, workspace).edges).toEqual([{ conceptId: target.id, prerequisiteId: canonical.id }]);
  });

  it('rejects inaccessible targets and invalid inputs before making changes', () => {
    const target = upsertConcept(db, { key: 'target', title: 'Target', portable: false, workspaceId: other });
    expect(() => transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('a')]))).toThrow(/not available/);
    const local = upsertConcept(db, { key: 'local', title: 'Local', portable: false, workspaceId: workspace });
    expect(() => transaction(db, () => persistTutorPrerequisites(db, workspace, local.id, [candidate('a'), candidate('b', ' ')]))).toThrow(/title/);
    expect(readWorkspaceGraph(db, workspace).edges).toEqual([]);
  });
});

it('keeps live foundations separate from the sample atlas', () => {
  seedDemoWorkspaces(db);
  const sample = db.prepare("SELECT id, title FROM concepts WHERE key LIKE 'Demo:%' LIMIT 1").get()!;
  const target = upsertConcept(db, { key: 'target', title: 'Target', portable: false, workspaceId: workspace });
  const [resolved] = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('foundation', String(sample.title))]));
  expect(resolved?.concept).toMatchObject({ key: 'foundation', title: sample.title });
  expect(resolved?.concept.id).not.toBe(sample.id);
});
