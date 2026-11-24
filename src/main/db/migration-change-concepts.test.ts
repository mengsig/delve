import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { readLesson } from '../reader/ipc';
import { cacheModel, selectModel } from '../providers/model';
import { cachedGeneration, digest, latestBrief, persistGeneration, type ApprovedSource } from '../repository/store';
import type { Depth } from '../../shared/domain';
import { addPrerequisite, upsertConcept } from './concepts';
import { recordEvidence, resetEvidence } from './evidence';
import { readWorkspaceGraph } from './graph';
import { getGlobalKnowledgeGraph } from './knowledge';
import { bindSnapshot } from './lessons';
import { migrate, MIGRATIONS } from './migrations';
import { addWorkspace } from './workspaces';

const head = 'a'.repeat(40);
const title = 'Keeping unconfirmed data';
const footprint = { key: 'pending-data', title, summary: 'Keep data until it is acknowledged.', portable: false };

it('rejects a reverse edge across a v10 alias path without displacing the existing prerequisite', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, MIGRATIONS.slice(0, 10));
    const workspaceId = addWorkspace(db, { kind: 'github', owner: 'acme', repo: 'web' }).id;
    const snapshotId = bindSnapshot(db, workspaceId, head);
    const canonical = upsertConcept(db, { ...footprint, key: 'change/' + digest(['old', 'codex', 'model']), workspaceId });
    const legacy = upsertConcept(db, { ...footprint, key: 'change/' + digest(['old', 'codex', 'other-model']), workspaceId });
    const other = upsertConcept(db, { key: 'other', title: 'Other', portable: false, workspaceId });
    seedSavedChange(db, workspaceId, snapshotId, canonical.id, canonical.id, 'high');
    seedSavedChange(db, workspaceId, snapshotId, legacy.id, legacy.id, 'low');
    db.prepare('INSERT INTO concept_edges VALUES (?, ?, ?)').run(legacy.id, other.id, '2026-01-01');
    migrate(db);
    expect(readWorkspaceGraph(db, workspaceId, true).edges).toEqual([{ conceptId: canonical.id, prerequisiteId: other.id }]);
    expect(() => addPrerequisite(db, other.id, canonical.id)).toThrow(/cycle/);
    expect(() => addPrerequisite(db, other.id, legacy.id)).toThrow(/cycle/);
    expect(readWorkspaceGraph(db, workspaceId, true).edges).toEqual([{ conceptId: canonical.id, prerequisiteId: other.id }]);
  } finally { db.close(); }
});

function seedSavedChange(db: DatabaseSync, workspaceId: string, snapshotId: number, conceptId: number, touchedId: number, depth: Depth,
  options: { cacheKey?: string; provider?: 'codex' | 'claude'; footprint?: typeof footprint; omitLessonId?: boolean } = {}) {
  const { cacheKey = depth, provider = 'codex', footprint: affected = footprint, omitLessonId } = options;
  const model = cacheModel(selectModel(provider).model);
  const document = { schema: 'delve.lesson/1', source: head, blocks: [{ type: 'prose', heading: 'What changed', text: depth + ' lesson' }] };
  const lessonId = db.prepare(`INSERT INTO lessons (cache_key, schema_version, concept_id, workspace_id, snapshot_id, depth, provider, model, body, created_at)
    VALUES (?, 'delve.lesson/1', ?, ?, ?, ?, ?, ?, ?, '2026-01-01')`)
    .run(cacheKey, conceptId, workspaceId, snapshotId, depth, provider, model, JSON.stringify(document)).lastInsertRowid;
  const result = { kind: 'change', brief: { conceptId, lessonId: omitLessonId ? undefined : Number(lessonId), commit: head, title,
    touched: [{ id: touchedId, title: affected.title }], recommendation: { conceptId: touchedId, title: affected.title, reason: 'Start with this change.' } } };
  db.prepare(`INSERT INTO repository_generations (cache_key, workspace_id, snapshot_id, kind, ref, depth, provider, model, schema_version,
    result, proposal, next_concept, reason, created_at, last_used) VALUES (?, ?, ?, 'pr', '42', ?, ?, ?, 'delve.change/1',
    ?, ?, ?, 'Start here.', '2026-01-01', (SELECT coalesce(max(last_used), 0) + 1 FROM repository_generations))`)
    .run(cacheKey, workspaceId, snapshotId, depth, provider, model,
      JSON.stringify(result), JSON.stringify({ concepts: [affected], conceptTitle: title, touched: [affected.key] }), touchedId);
  return Number(lessonId);
}

it('keeps same-title v10 concepts with different meanings separate through upgrade and regeneration', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 10));
    const workspaceId = addWorkspace(db, { kind: 'github', owner: 'acme', repo: 'web' }).id;
    const snapshotId = bindSnapshot(db, workspaceId, head);
    const dns = { key: 'dns', title: 'Caching', summary: 'Keep DNS responses until they expire.', portable: false };
    const page = { key: 'pages', title: 'Caching', summary: 'Keep a copy of rendered pages.', portable: false };
    const saveFootprint = (input: typeof dns) => {
      const fingerprint = digest([input.key, input.summary.toLowerCase()]);
      const concept = upsertConcept(db, { ...input, workspaceId, key: 'change/' + digest(['concept', snapshotId, fingerprint]) });
      db.prepare('INSERT INTO snapshot_concepts VALUES (?, ?)').run(snapshotId, concept.id);
      return concept.id;
    };
    const dnsId = saveFootprint(dns);
    const pageId = saveFootprint(page);
    const overview = upsertConcept(db, { ...dns, key: 'change/overview', title, workspaceId });
    seedSavedChange(db, workspaceId, snapshotId, overview.id, dnsId, 'high', { footprint: dns });
    seedSavedChange(db, workspaceId, snapshotId, overview.id, pageId, 'low', { footprint: page });
    recordEvidence(db, { workspaceId, snapshotId, conceptId: pageId, depth: 'low',
      status: 'demonstrated', source: 'check', masteryVerified: true });

    migrate(db);
    migrate(db);
    expect(getGlobalKnowledgeGraph(db).concepts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: dnsId, masteredDepth: null }), expect.objectContaining({ id: pageId, masteredDepth: 'low' }),
    ]));
    const source: ApprovedSource = { cacheKey: 'regenerated', revision: head,
      request: { workspaceId, selection: { kind: 'pr', ref: '42' }, depth: 'medium', provider: 'codex' },
      preview: { ...selectModel('codex'), title, commit: head, bytes: 1, prompt: 'test', files: [], token: 'test', partial: false } };
    const refreshedPage = { ...page, key: 'page-cache' };
    expect(persistGeneration(db, source, { schema: 'delve.change/1', concepts: [dns, refreshedPage], edges: [],
      touched: [dns.key, refreshedPage.key], spans: [], summary: 'Review caching changes.', what: 'The caches change.',
      why: 'This keeps responses current.', before: 'The old caches.', after: 'The new caches.', trace: [], excerpt: [],
      mechanics: null, boundary: null, recommendation: { key: refreshedPage.key, reason: 'Read about page caching.' },
    })).toMatchObject({ brief: { touched: [{ id: dnsId }, { id: pageId }], recommendation: { conceptId: pageId } } });
    expect(getGlobalKnowledgeGraph(db).concepts).toHaveLength(3);
  } finally {
    db.close();
  }
});

it('recovers exact v10 lesson IDs for saved briefs at the same depth across providers', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 10));
    const workspaceId = addWorkspace(db, { kind: 'github', owner: 'acme', repo: 'web' }).id;
    const snapshotId = bindSnapshot(db, workspaceId, head);
    const codex = upsertConcept(db, { ...footprint, key: 'change/codex', workspaceId });
    const claude = upsertConcept(db, { ...footprint, key: 'change/claude', workspaceId });
    const codexId = seedSavedChange(db, workspaceId, snapshotId, codex.id, codex.id, 'high',
      { cacheKey: 'codex-brief', omitLessonId: true });
    const claudeId = seedSavedChange(db, workspaceId, snapshotId, claude.id, claude.id, 'high',
      { cacheKey: 'claude-brief', provider: 'claude', omitLessonId: true });
    migrate(db);
    migrate(db);
    const address = { workspaceId, kind: 'pr', ref: '42', depth: 'high' } as const;
    expect(cachedGeneration(db, 'codex-brief')).toMatchObject({ brief: { conceptId: codex.id, lessonId: codexId } });
    expect(latestBrief(db, { ...address, provider: 'claude' })).toMatchObject({ conceptId: codex.id, lessonId: claudeId });
    expect(codexId).not.toEqual(claudeId);
  } finally {
    db.close();
  }
});

it('reconciles v10 PR duplicates without losing the strongest evidence or historical lessons', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 10));
    const workspaceId = addWorkspace(db, { kind: 'github', owner: 'acme', repo: 'web' }).id;
    const snapshotId = bindSnapshot(db, workspaceId, head);
    const make = (key: string) => upsertConcept(db, { ...footprint, workspaceId, key });
    const high = make('change/' + digest(['old', 'codex', 'model']));
    const low = make('change/' + digest(['old', 'codex', 'other-model']));
    const medium = make('change/' + digest(['old', 'claude', 'model']));
    const duplicate = make('change/' + digest(['concept', snapshotId, digest([footprint.key, footprint.summary.toLowerCase()])]));
    const other = make('unrelated');
    for (const concept of [high, low, medium, duplicate]) db.prepare('INSERT INTO snapshot_concepts VALUES (?, ?)').run(snapshotId, concept.id);
    seedSavedChange(db, workspaceId, snapshotId, high.id, duplicate.id, 'high');
    seedSavedChange(db, workspaceId, snapshotId, low.id, duplicate.id, 'low');
    seedSavedChange(db, workspaceId, snapshotId, medium.id, duplicate.id, 'medium');
    db.prepare('INSERT INTO concept_edges VALUES (?, ?, ?)').run(duplicate.id, other.id, '2026-01-01');
    const evidence = (conceptId: number, depth: Depth, verified: boolean) => recordEvidence(db, { conceptId, workspaceId, snapshotId, depth,
      status: verified ? 'demonstrated' : 'partial', source: 'check', masteryVerified: verified });
    evidence(duplicate.id, 'high', true);
    evidence(high.id, 'high', false);
    evidence(high.id, 'high', false);
    evidence(low.id, 'low', true);

    migrate(db);
    migrate(db);
    const graph = readWorkspaceGraph(db, workspaceId, true);
    expect(graph.concepts.map(c => c.id)).toEqual([high.id, other.id]);
    expect(graph.edges).toEqual([{ conceptId: high.id, prerequisiteId: other.id }]);
    expect(graph.evidence).toMatchObject([{ conceptId: high.id, depth: 'high', status: 'demonstrated' },
      { conceptId: high.id, depth: 'low', status: 'demonstrated' }]);
    expect(getGlobalKnowledgeGraph(db).concepts.find(c => c.id === high.id)?.masteredDepth).toBe('low');
    expect(cachedGeneration(db, 'low')).toMatchObject({ brief: { conceptId: high.id, touched: [{ id: high.id }], recommendation: { conceptId: high.id } } });
    expect(readLesson(db, { conceptId: high.id, workspaceId, depth: 'low' })).toMatchObject({
      mastery: { stage: 'understood' }, blocks: [{ text: 'low lesson' }],
    });
    expect(readLesson(db, { conceptId: high.id, workspaceId, depth: 'medium' })).toMatchObject({
      mastery: { stage: 'teaching' }, blocks: [{ text: 'medium lesson' }],
    });
    expect(resetEvidence(db, high.id, { workspaceId, depth: 'low' })).toBe(1);
    expect(getGlobalKnowledgeGraph(db).concepts.find(c => c.id === high.id)?.masteredDepth).toBe('high');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
  }
});
