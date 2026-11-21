import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addPrerequisite, conceptStorageKey, listPrerequisites, listWorkspaceConcepts, upsertConcept } from './concepts';
import { openDatabase, type Db } from './connection';
import { isConceptKnown, listEvidence, recordEvidence, resetEvidence } from './evidence';
import { bindSnapshot, getLessonByCacheKey, lessonCacheKey, saveLesson } from './lessons';
import { addWorkspace } from './workspaces';

let db: Db;
let wsA: string;
let wsB: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  wsA = addWorkspace(db, { kind: 'github', owner: 'acme', repo: 'edge' }).id;
  wsB = addWorkspace(db, { kind: 'git', path: '/srv/other' }).id;
});

afterEach(() => db.close());

describe('concepts', () => {
  it('shares one portable concept across workspaces', () => {
    const inA = upsertConcept(db, { key: 'nginx/reverse-proxy', title: 'Nginx reverse proxy', portable: true, workspaceId: wsA });
    const inB = upsertConcept(db, { key: 'NGINX/reverse-proxy', title: 'Nginx reverse proxy', portable: true, workspaceId: wsB });
    expect(inB.id).toBe(inA.id);
    expect(listWorkspaceConcepts(db, wsA).map((c) => c.id)).toEqual([inA.id]);
    expect(listWorkspaceConcepts(db, wsB).map((c) => c.id)).toEqual([inA.id]);
  });

  it('keeps local concepts per workspace and refuses changing portability', () => {
    const a = upsertConcept(db, { key: 'lease-store', title: 'Lease store', portable: false, workspaceId: wsA });
    const b = upsertConcept(db, { key: 'lease-store', title: 'Lease store', portable: false, workspaceId: wsB });
    expect(a.id).not.toBe(b.id);
    expect(a.key).toBe(conceptStorageKey('lease-store', false, wsA));
    upsertConcept(db, { key: 'tls', title: 'TLS', portable: true });
    expect(() => upsertConcept(db, { key: 'tls', title: 'TLS', portable: false, workspaceId: wsA })).not.toThrow();
    expect(() => upsertConcept(db, { key: a.key, title: 'x', portable: true })).toThrow(/different portability/);
    expect(() => upsertConcept(db, { key: 'Bad Key!', title: 'x', portable: true })).toThrow(/not a valid concept key/);
  });

  it('updates title and summary on upsert without duplicating', () => {
    const first = upsertConcept(db, { key: 'http', title: 'HTTP', summary: 'Protocol', portable: true });
    const second = upsertConcept(db, { key: 'http', title: 'HTTP/1.1', portable: true });
    expect(second).toMatchObject({ id: first.id, title: 'HTTP/1.1', summary: 'Protocol' });
  });
});

describe('prerequisite edges', () => {
  it('adds edges idempotently and rejects self-loops and cycles', () => {
    const tcp = upsertConcept(db, { key: 'tcp', title: 'TCP', portable: true }).id;
    const http = upsertConcept(db, { key: 'http', title: 'HTTP', portable: true }).id;
    const proxy = upsertConcept(db, { key: 'nginx/reverse-proxy', title: 'Proxy', portable: true }).id;
    addPrerequisite(db, http, tcp);
    addPrerequisite(db, proxy, http);
    addPrerequisite(db, proxy, http);
    expect(listPrerequisites(db, proxy).map((c) => c.id)).toEqual([http]);
    expect(() => addPrerequisite(db, tcp, proxy)).toThrow(/cycle/);
    expect(() => addPrerequisite(db, tcp, tcp)).toThrow(/cannot require itself/);
    expect(listPrerequisites(db, tcp)).toEqual([]);
  });

  it('keeps portable concepts free of workspace-specific prerequisites', () => {
    const portable = upsertConcept(db, { key: 'queues', title: 'Queues', portable: true }).id;
    const local = upsertConcept(db, { key: 'worker', title: 'Worker', portable: false, workspaceId: wsA }).id;
    const otherLocal = upsertConcept(db, { key: 'worker', title: 'Worker', portable: false, workspaceId: wsB }).id;
    expect(() => addPrerequisite(db, portable, local)).toThrow(/cannot require workspace-specific/);
    expect(() => addPrerequisite(db, local, otherLocal)).toThrow(/another workspace/);
    expect(() => addPrerequisite(db, local, portable)).not.toThrow();
    expect(() => addPrerequisite(db, local, 9999)).toThrow(/does not exist/);
  });
});

describe('evidence and reuse', () => {
  it('reuses a portable concept demonstrated in another workspace, at that depth or shallower', () => {
    const proxy = upsertConcept(db, { key: 'nginx/reverse-proxy', title: 'Proxy', portable: true, workspaceId: wsA });
    recordEvidence(db, { conceptId: proxy.id, depth: 'medium', status: 'demonstrated', source: 'check', workspaceId: wsA });
    expect(isConceptKnown(db, { conceptKey: proxy.key, depth: 'medium', workspaceId: wsB })).toMatchObject({ known: true, viaDepth: 'medium' });
    expect(isConceptKnown(db, { conceptKey: proxy.key, depth: 'high', workspaceId: wsB }).known).toBe(true);
    expect(isConceptKnown(db, { conceptKey: proxy.key, depth: 'low', workspaceId: wsB }).known).toBe(false);
  });

  it('never reuses a local concept outside its workspace, nor partial evidence', () => {
    const local = upsertConcept(db, { key: 'lease', title: 'Lease', portable: false, workspaceId: wsA });
    recordEvidence(db, { conceptId: local.id, depth: 'low', status: 'demonstrated', source: 'environment' });
    expect(isConceptKnown(db, { conceptKey: local.key, depth: 'high', workspaceId: wsA }).known).toBe(true);
    expect(isConceptKnown(db, { conceptKey: local.key, depth: 'high', workspaceId: wsB }).known).toBe(false);
    const tls = upsertConcept(db, { key: 'tls', title: 'TLS', portable: true });
    recordEvidence(db, { conceptId: tls.id, depth: 'high', status: 'partial', source: 'check' });
    expect(isConceptKnown(db, { conceptKey: 'tls', depth: 'high', workspaceId: wsA }).known).toBe(false);
    expect(isConceptKnown(db, { conceptKey: 'missing', depth: 'high', workspaceId: wsA }).reason).toMatch(/No such concept/);
  });

  it('revises evidence in place and resets it per depth or entirely', () => {
    const c = upsertConcept(db, { key: 'dns', title: 'DNS', portable: true });
    recordEvidence(db, { conceptId: c.id, depth: 'medium', status: 'partial', source: 'check' });
    const revised = recordEvidence(db, { conceptId: c.id, depth: 'medium', status: 'demonstrated', source: 'check', note: 'second try' });
    expect(revised).toMatchObject({ revision: 2, status: 'demonstrated', note: 'second try' });
    recordEvidence(db, { conceptId: c.id, depth: 'high', status: 'demonstrated', source: 'self-report' });
    expect(listEvidence(db, c.id).map((e) => e.depth)).toEqual(['high', 'medium']);
    expect(resetEvidence(db, c.id, 'medium')).toBe(1);
    expect(isConceptKnown(db, { conceptKey: 'dns', depth: 'medium', workspaceId: wsA }).known).toBe(false);
    expect(resetEvidence(db, c.id)).toBe(1);
    expect(listEvidence(db, c.id)).toEqual([]);
  });

  it('rejects evidence for unknown concepts or values', () => {
    expect(() => recordEvidence(db, { conceptId: 404, depth: 'high', status: 'demonstrated', source: 'check' })).toThrow(/does not exist/);
    const c = upsertConcept(db, { key: 'x', title: 'X', portable: true });
    // @ts-expect-error invalid status reaches the boundary check
    expect(() => recordEvidence(db, { conceptId: c.id, depth: 'high', status: 'mastered', source: 'check' })).toThrow(/status/);
  });
});

describe('lessons and snapshots', () => {
  const parts = { schemaVersion: 'delve.lesson/1', conceptKey: 'tcp', depth: 'medium', provider: 'claude', model: 'm', sourceRef: 'abc1234' } as const;

  it('derives a cache key that changes with every part', () => {
    const key = lessonCacheKey(parts);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(lessonCacheKey({ ...parts })).toBe(key);
    expect(lessonCacheKey({ ...parts, depth: 'low' })).not.toBe(key);
    expect(lessonCacheKey({ ...parts, model: 'other' })).not.toBe(key);
    expect(() => lessonCacheKey({ ...parts, schemaVersion: 'lesson' })).toThrow();
  });

  it('binds snapshots once and stores lessons by cache key', () => {
    const snap = bindSnapshot(db, wsA, 'ABCDEF1234');
    expect(bindSnapshot(db, wsA, 'abcdef1234')).toBe(snap);
    expect(() => bindSnapshot(db, wsA, 'not-a-sha')).toThrow(/not a commit/);
    const concept = upsertConcept(db, { key: 'tcp', title: 'TCP', portable: true });
    const cacheKey = lessonCacheKey(parts);
    saveLesson(db, { ...parts, cacheKey, conceptId: concept.id, snapshotId: snap, workspaceId: wsA, body: { blocks: [1] } });
    const replaced = saveLesson(db, { ...parts, cacheKey, conceptId: concept.id, body: { blocks: [2] } });
    expect(replaced.body).toEqual({ blocks: [2] });
    expect(getLessonByCacheKey(db, cacheKey)?.snapshotId).toBe(snap);
    expect(() => saveLesson(db, { ...parts, schemaVersion: 'v1', cacheKey: 'k', conceptId: concept.id, body: {} })).toThrow(/Unknown lesson schema/);
  });
});
