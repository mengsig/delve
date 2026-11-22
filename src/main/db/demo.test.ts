import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection';
import { isDemoWorkspace, seedDemoWorkspaces } from './demo';
import { resetEvidence } from './evidence';
import { readWorkspaceCoverage, readWorkspaceGraph } from './graph';
import { addWorkspace, listWorkspaces } from './workspaces';

let db: Db;

beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => db.close());

describe('demo workspaces', () => {
  it('seeds the three mockup maps with scoped concepts, snapshots and shared evidence', () => {
    seedDemoWorkspaces(db);
    const { workspaces, activeId } = listWorkspaces(db);
    expect(workspaces.map(({ name }) => name)).toEqual(['Archon (demo)', 'Relay (demo)', 'Photography (demo)']);
    const [archon, relay, photo] = workspaces;
    expect(activeId).toBe(archon!.id);
    const graphs = [archon!, relay!, photo!].map(({ id }) => readWorkspaceGraph(db, id));
    const [archonGraph, relayGraph, photoGraph] = graphs;
    expect(graphs.map(({ demo, snapshot, concepts }) => [demo, snapshot, concepts.map(({ key }) => key.split(':').at(-1))])).toEqual([
      [true, '8c2a1d7', ['queue', 'clock', 'lease', 'fence', 'journal', 'recovery']],
      [true, 'f3a927b', ['queue', 'clock', 'delivery', 'retry', 'journal', 'recovery']],
      [true, null, ['light', 'frame', 'exposure', 'shutter', 'iso', 'pan']],
    ]);
    expect(graphs.map(({ concepts, edges }) => {
      const keyById = new Map(concepts.map(({ id, key }) => [id, key.split(':').at(-1)]));
      return edges.map(({ conceptId, prerequisiteId }) => `${keyById.get(prerequisiteId)}:${keyById.get(conceptId)}`);
    })).toEqual([
      ['queue:lease', 'clock:lease', 'lease:fence', 'queue:journal', 'fence:recovery', 'journal:recovery'],
      ['queue:delivery', 'clock:retry', 'delivery:retry', 'delivery:journal', 'retry:recovery', 'journal:recovery'],
      ['light:exposure', 'frame:exposure', 'exposure:shutter', 'light:iso', 'shutter:pan', 'iso:pan'],
    ]);
    expect(archonGraph!.concepts[0]!.id).toBe(relayGraph!.concepts[0]!.id);
    expect(archonGraph!.concepts[4]!.id).not.toBe(relayGraph!.concepts[4]!.id);
    expect(archonGraph!.evidence).toHaveLength(5);
    expect(archonGraph!.evidence.every((row) => row.workspaceId === relay!.id && row.workspaceName === relay!.name)).toBe(true);
    expect(photoGraph!.evidence).toHaveLength(4);
  });

  it('keeps real workspace selection and never repopulates reset demo evidence', () => {
    const realRepo = addWorkspace(db, { kind: 'github', owner: 'example', repo: 'archon' });
    const realTopic = addWorkspace(db, { kind: 'topic', title: 'Photography' });
    seedDemoWorkspaces(db);
    expect(listWorkspaces(db).activeId).toBe(realTopic.id);
    for (const real of [realRepo, realTopic]) {
      expect(isDemoWorkspace(db, real.id)).toBe(false);
      expect(readWorkspaceGraph(db, real.id)).toMatchObject({ concepts: [], evidence: [], demo: false });
    }
    const relay = listWorkspaces(db).workspaces.find(({ name }) => name === 'Relay (demo)')!;
    const queue = readWorkspaceGraph(db, relay.id).concepts[0]!;
    expect(resetEvidence(db, queue.id, { workspaceId: relay.id, depth: 'medium' })).toBe(1);

    seedDemoWorkspaces(db);
    expect(listWorkspaces(db).workspaces).toHaveLength(5);
    expect(listWorkspaces(db).activeId).toBe(realTopic.id);
    expect(readWorkspaceCoverage(db).find(({ workspaceId }) => workspaceId === relay.id)?.known).toEqual({ high: 4, medium: 2, low: 1 });
  });
});
