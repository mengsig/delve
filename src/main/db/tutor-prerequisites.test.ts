import { afterEach, beforeEach, expect, it } from 'vitest';
import { addPrerequisite, upsertConcept, upsertConceptInTransaction } from './concepts';
import { openDatabase, transaction, type Db } from './connection';
import { seedDemoWorkspaces } from './demo';
import { listEvidence, recordEvidence } from './evidence';
import { readWorkspaceGraph } from './graph';
import { findTutorPrerequisite, persistTutorPrerequisites } from './tutor-prerequisites';
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

it('links a recognized portable key alias to its verified foundation in another workspace', () => {
  const known = upsertConcept(db, { ...candidate('queues', 'Queues'), portable: true, workspaceId: other });
  const target = upsertConcept(db, { ...candidate('target', 'Topic'), portable: false, workspaceId: workspace });
  recordEvidence(db, { conceptId: known.id, depth: 'low', status: 'demonstrated', source: 'check', masteryVerified: true });
  const alias = { key: 'queue', title: 'Queue', summary: known.summary };
  const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [alias]));
  expect(result.map(item => item.concept.id)).toEqual([known.id]);
  const graph = readWorkspaceGraph(db, workspace, true);
  expect(graph.edges).toContainEqual({ conceptId: target.id, prerequisiteId: known.id });
  expect(listEvidence(db, known.id)).toMatchObject([{ conceptId: known.id, masteryVerified: true }]);
  expect(findTutorPrerequisite(db, workspace, { ...alias, summary: 'Deliver newest jobs first.' })).toBeNull();
  expect(findTutorPrerequisite(db, workspace, { ...alias, title: 'Message queues' })).toBeNull();
});

  it('rejects conflicting descriptions and aliases, including unscoped local keys', () => {
    const local = upsertConcept(db, { key: 'tcp', title: 'Transport', summary: 'A protocol.', portable: false, workspaceId: workspace });
    expect(findTutorPrerequisite(db, workspace, candidate('tcp', 'Transport'))).toBeNull();
    expect(findTutorPrerequisite(db, workspace, { key: 'http', title: 'Transport', summary: 'A protocol.' })).toBeNull();
    expect(findTutorPrerequisite(db, workspace, { key: 'tcp', title: 'Transport', summary: 'A protocol.' })?.id).toBe(local.id);
  });
  it('reuses an exact scoped key while keeping a matching title and summary on another key separate', () => {
    const target = upsertConcept(db, { key: 'target', title: 'Target', portable: false, workspaceId: workspace });
    const local = upsertConcept(db, { key: 'local', title: '  Shared Name ', summary: 'Existing local', portable: false, workspaceId: workspace });
    upsertConcept(db, { key: 'shared', title: 'Shared Name', portable: true, workspaceId: other });
    const portable = upsertConcept(db, { key: 'portable', title: 'Portable', summary: 'Existing portable', portable: true, workspaceId: other });
    upsertConcept(db, { key: 'private', title: 'Private', portable: false, workspaceId: other });
    const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [
      { ...candidate('new-key', 'shared   name'), summary: 'Existing local' },
      { ...candidate('local', 'Changed'), summary: 'Existing local' },
      { ...candidate('portable', 'Changed'), summary: 'Existing portable' }, candidate('private', 'Private'),
    ]));
    expect(result.map(item => [item.concept.id, item.candidateKey])).toEqual([[expect.any(Number), 'new-key'], [local.id, 'local'], [portable.id, 'portable'], [expect.any(Number), 'private']]);
    expect(result[0]!.concept.id).not.toBe(local.id);
    expect(result[1]!.concept.summary).toBe('Existing local');
    expect(result[2]!.concept.summary).toBe('Existing portable');
    expect(result[2]!.concept.portable).toBe(true);
    expect(readWorkspaceGraph(db, workspace).edges).toHaveLength(4);
  });

  it('omits self and cycles without leaking membership and preserves valid siblings', () => {
    const target = upsertConcept(db, { ...candidate('target', 'Target'), portable: false, workspaceId: workspace });
    const cycle = upsertConcept(db, { ...candidate('cycle', 'Cycle'), portable: false, workspaceId: workspace });
    addPrerequisite(db, cycle.id, target.id);
    db.prepare('DELETE FROM workspace_concepts WHERE workspace_id = ? AND concept_id = ?').run(workspace, cycle.id);
    const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('target', 'Target'), candidate('cycle', 'Cycle'), candidate('valid', 'Valid')]));
    expect(result.map(row => row.candidateKey)).toEqual(['valid']);
    expect(readWorkspaceGraph(db, workspace).concepts.map(c => c.id)).not.toContain(cycle.id);
    expect(readWorkspaceGraph(db, workspace).edges).toEqual([{ conceptId: target.id, prerequisiteId: result[0]!.concept.id }]);
  });

  it('skips an obvious self prerequisite when the target has no description', () => {
    const target = upsertConcept(db, { key: 'target', title: 'Target', portable: false, workspaceId: workspace });
    const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('target', 'Target')]));
    expect(result).toEqual([]);
    expect(readWorkspaceGraph(db, workspace).edges).toEqual([]);
  });

  it('orders direct and transitive dependencies before dependents while keeping ready candidates stable', () => {
    const target = upsertConcept(db, { key: 'target', title: 'Target', portable: true, workspaceId: workspace });
    const a = upsertConcept(db, { ...candidate('a'), portable: true });
    const b = upsertConcept(db, { ...candidate('b'), portable: true });
    const intermediate = upsertConcept(db, { key: 'intermediate', title: 'Intermediate', portable: true });
    const c = upsertConcept(db, { ...candidate('c'), portable: true });
    addPrerequisite(db, a.id, intermediate.id);
    addPrerequisite(db, intermediate.id, c.id);
    const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('a'), candidate('b'), candidate('c')]));
    expect(result.map(row => row.concept.id)).toEqual([b.id, c.id, a.id]);
  });

  it('orders prerequisites through migrated alias paths', () => {
    const target = upsertConcept(db, { ...candidate('target'), portable: true, workspaceId: workspace });
    const advanced = upsertConcept(db, { ...candidate('advanced'), portable: true, workspaceId: workspace });
    const basic = upsertConcept(db, { ...candidate('basic'), portable: true, workspaceId: workspace });
    const legacy = upsertConcept(db, { ...candidate('old'), portable: false, workspaceId: workspace });
    db.prepare('INSERT INTO concept_edges VALUES (?, ?, ?)').run(legacy.id, basic.id, '2026-01-01');
    db.prepare('INSERT INTO concept_identity_links (legacy_concept_id, canonical_concept_id) VALUES (?, ?)').run(legacy.id, advanced.id);
    const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('advanced'), candidate('basic')]));
    expect(result.map(row => row.concept.id)).toEqual([basic.id, advanced.id]);
  });

  it('keeps hidden change targets hidden while promoting prerequisites', () => {
    const target = transaction(db, () => upsertConceptInTransaction(db, { key: 'change', title: 'Change', portable: false, workspaceId: workspace }, false));
    const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('foundation')]));
    expect(readWorkspaceGraph(db, workspace).concepts.map(c => c.id)).toEqual([result[0]!.concept.id]);
    expect(readWorkspaceGraph(db, workspace, true).edges).toEqual([{ conceptId: target.id, prerequisiteId: result[0]!.concept.id }]);
  });

  it('keeps a portable target from reusing a local key with an incompatible released identity link', () => {
    const target = upsertConcept(db, { key: 'target', title: 'Target', portable: true, workspaceId: workspace });
    const legacy = upsertConcept(db, { key: 'old', title: 'Foundation', portable: false, workspaceId: workspace });
    const canonical = upsertConcept(db, { ...candidate('canonical', 'Foundation'), portable: true });
    db.prepare('INSERT INTO concept_identity_links (legacy_concept_id, canonical_concept_id) VALUES (?, ?)').run(legacy.id, canonical.id);
    const result = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('old', 'Foundation')]));
    expect(result[0]?.concept).toMatchObject({ key: 'old', portable: true });
    expect(result[0]?.concept.id).not.toBe(canonical.id);
    expect(readWorkspaceGraph(db, workspace).edges).toEqual([{ conceptId: target.id, prerequisiteId: result[0]!.concept.id }]);
  });

  it('rejects inaccessible targets and invalid inputs before making changes', () => {
    const target = upsertConcept(db, { key: 'target', title: 'Target', portable: false, workspaceId: other });
    expect(() => transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('a')]))).toThrow(/not available/);
    const local = upsertConcept(db, { key: 'local', title: 'Local', portable: false, workspaceId: workspace });
    expect(() => transaction(db, () => persistTutorPrerequisites(db, workspace, local.id, [candidate('a'), candidate('b', ' ')]))).toThrow(/title/);
    expect(readWorkspaceGraph(db, workspace).edges).toEqual([]);
  });
it('keeps live foundations separate from the sample atlas', () => {
  seedDemoWorkspaces(db);
  const sample = db.prepare("SELECT id, title FROM concepts WHERE key LIKE 'Demo:%' LIMIT 1").get()!;
  const target = upsertConcept(db, { key: 'target', title: 'Target', portable: false, workspaceId: workspace });
  const [resolved] = transaction(db, () => persistTutorPrerequisites(db, workspace, target.id, [candidate('foundation', String(sample.title))]));
  expect(resolved?.concept).toMatchObject({ key: 'foundation', title: sample.title });
  expect(resolved?.concept.id).not.toBe(sample.id);
});
