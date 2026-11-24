import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { upsertConcept } from '../db/concepts';
import { openDatabase, transaction, type Db } from '../db/connection';
import { listEvidence, recordEvidence } from '../db/evidence';
import { bindSnapshot, saveLesson } from '../db/lessons';
import { addWorkspace, switchWorkspace } from '../db/workspaces';
import { readLesson } from '../reader/ipc';
import { appendEntries } from '../reader/conversation';
import { lessonContext } from '../reader/stored-lesson';
import { documentSchema } from '../reader/document';
import { prepareTurn } from '../tutor/prompt';
import { LabHost } from './host';
import { labSchemas } from './ipc';

let db: Db;
let address: { workspaceId: string; conceptId: number; depth: 'medium' };
const block = { type: 'environment', runtime: 'delve.env/1', pack: 'lease-handoff@1', fallback: 'Compare the claims.' };

function save(blocks: unknown[]) {
  saveLesson(db, { ...address, cacheKey: 'activity', provider: 'codex', model: 'model', schemaVersion: 'delve.lesson/1',
    body: { schema: 'delve.lesson/1', blocks } });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  const workspace = addWorkspace(db, { kind: 'topic', title: 'Queues' });
  const concept = upsertConcept(db, { workspaceId: workspace.id, key: 'lease', title: 'Lease', portable: true });
  address = { workspaceId: workspace.id, conceptId: concept.id, depth: 'medium' };
  save([block]);
});
afterEach(() => { vi.useRealTimers(); db.close(); });

function openRequest() {
  return { ...address, revision: readLesson(db, address).revision, messageId: null, blockIndex: 0 };
}

describe('activity host', () => {
  it('requires a current lesson, active workspace, ordered inputs and a live session', () => {
    const labs = new LabHost(db);
    const request = openRequest();
    const opened = labs.open(request);
    expect(opened.manifest).toMatchObject({ runtime: 'delve.env/1', config: { pack: 'lease-handoff@1' },
      eventSchema: { type: 'object' }, rubric: 'compare-generation@1', fallback: block.fallback });
    expect(() => labs.input({ session: opened.session, seq: 2, input: { type: 'reset' } })).toThrow(/order/);
    expect(labs.input({ session: opened.session, seq: 1, input: { type: 'reset' } }).state).toBeTruthy();
    expect(() => labs.input({ session: opened.session, seq: 1, input: { type: 'reset' } })).toThrow(/order/);
    const other = addWorkspace(db, { kind: 'topic', title: 'Other' });
    expect(() => labs.input({ session: opened.session, seq: 2, input: { type: 'reset' } })).toThrow(/workspace/);
    switchWorkspace(db, address.workspaceId);
    save([{ ...block, fallback: 'A changed activity.' }]);
    expect(() => labs.open(request)).toThrow(/changed/);
    expect(() => labs.input({ session: opened.session, seq: 2, input: { type: 'reset' } })).toThrow(/changed/);
    expect(labs.close({ session: opened.session })).toBe(true);
    expect(labs.close({ session: opened.session })).toBe(false);
    expect(other.id).not.toBe(address.workspaceId);
  });

  it('expires sessions and validates request shape', () => {
    vi.useFakeTimers();
    const labs = new LabHost(db);
    const opened = labs.open(openRequest());
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(() => labs.input({ session: opened.session, seq: 1, input: { type: 'reset' } })).toThrow(/expired/);
    expect(labSchemas['lab:open'].safeParse({ ...openRequest(), blockIndex: -1 }).success).toBe(false);
    expect(labSchemas['lab:input'].safeParse({ session: opened.session, seq: 0, input: {} }).success).toBe(false);
  });

  it('retires replaced sessions and terminates a flood before it can change evidence', () => {
    const labs = new LabHost(db);
    const request = openRequest();
    const old = labs.open(request);
    const { session } = labs.open(request);
    expect(() => labs.input({ session: old.session, seq: 1, input: { type: 'reset' } })).toThrow(/expired/);
    for (let seq = 1; seq <= 120; seq++) labs.input({ session, seq, input: { type: 'reset' } });
    expect(() => labs.input({ session, seq: 121, input: { type: 'advance' } })).toThrow(/budget/);
    expect(() => labs.input({ session, seq: 121, input: { type: 'reset' } })).toThrow(/expired/);
    expect(listEvidence(db, address.conceptId)).toEqual([]);
  });

});

describe('saved activity provenance', () => {
  it('keeps a saved tutor instrument bound to its original snapshot', () => {
    const labs = new LabHost(db);
    bindSnapshot(db, address.workspaceId, '1111aaaa');
    const lesson = documentSchema.parse({ schema: 'delve.lesson/1', blocks: [block] });
    const [message] = transaction(db, () => appendEntries(db, lessonContext(db, address), null, [{ role: 'tutor', text: '', lesson }]));
    const request = { ...openRequest(), messageId: message!.id };
    const { session } = labs.open(request);
    bindSnapshot(db, address.workspaceId, '2222bbbb');
    expect(() => labs.input({ session, seq: 1, input: { type: 'advance' } })).toThrow(/snapshot/);
    expect(() => labs.open({ ...openRequest(), messageId: message!.id })).toThrow(/snapshot/);
    expect(listEvidence(db, address.conceptId)).toEqual([]);
  });

  it('refuses a real tutor message from another workspace even for a shared concept', () => {
    const other = addWorkspace(db, { kind: 'topic', title: 'Other queues' });
    upsertConcept(db, { workspaceId: other.id, key: 'lease', title: 'Lease', portable: true });
    const context = lessonContext(db, { ...address, workspaceId: other.id });
    const lesson = documentSchema.parse({ schema: 'delve.lesson/1', blocks: [block] });
    const [foreign] = transaction(db, () => appendEntries(db, context, null, [{ role: 'tutor', text: '', lesson }]));
    switchWorkspace(db, address.workspaceId);
    const labs = new LabHost(db);
    expect(() => labs.open({ ...openRequest(), messageId: foreign!.id })).toThrow(/available/);
    const { session } = labs.open(openRequest());
    expect(() => labs.input({ session, seq: 1, input: { type: 'advance', demonstrated: true } })).toThrow(/invalid/);
    expect(listEvidence(db, address.conceptId)).toEqual([]);
  });

  it('opens a scoped follow-up bundle only when its source hash matches', () => {
    const source = 'function step(initial, action) { return {text: initial, controls: [], marks: []}; }';
    const config = { pack: 'bundle@1', bundle: { apiVersion: 'delve.view/1', entry: 'step', source,
      sha256: createHash('sha256').update(source).digest('hex') }, parameters: { title: 'Practice', initial: '' } };
    const lesson = documentSchema.parse({ schema: 'delve.lesson/1', blocks: [{ type: 'environment', config, fallback: 'Try it.' }] });
    const [message] = transaction(db, () => appendEntries(db, lessonContext(db, address), null,
      [{ role: 'tutor', text: 'Try this.', lesson }]));
    const labs = new LabHost(db);
    const request = { ...openRequest(), messageId: message!.id };
    const opened = labs.open(request);
    expect(opened.state).toBeNull();
    expect(() => labs.input({ session: opened.session, seq: 1, input: {} })).toThrow(/practice only/);
    expect(() => labs.open({ ...request, messageId: message!.id + 1 })).toThrow(/available/);
    save([{ type: 'environment', config: { ...config, bundle: { ...config.bundle, sha256: '0'.repeat(64) } } }]);
    expect(() => labs.open(openRequest())).toThrow(/integrity/);
    expect(listEvidence(db, address.conceptId)).toEqual([]);
  });
});

it('uses only the selected saved lesson’s instrument messages within the same snapshot and depth', () => {
  const snapshotId = bindSnapshot(db, address.workspaceId, '1111aaaa');
  const makeRequest = (provider: 'codex' | 'claude', fallback: string) => {
    const document = documentSchema.parse({ schema: 'delve.lesson/1', blocks: [{ ...block, fallback }] });
    const saved = saveLesson(db, { ...address, snapshotId, provider, cacheKey: provider, model: 'model',
      schemaVersion: document.schema, body: document });
    const pinned = { ...address, lessonId: saved.id };
    const context = lessonContext(db, pinned);
    const [message] = transaction(db, () => appendEntries(db, context, saved.id, [{ role: 'tutor', text: '', lesson: document }]));
    expect(context.snapshotId).toBe(snapshotId);
    expect(readLesson(db, pinned).messages.map(entry => entry.id)).toEqual([message!.id]);
    return { ...pinned, revision: readLesson(db, pinned).revision, messageId: message!.id, blockIndex: 0 };
  };
  const codex = makeRequest('codex', 'Codex activity');
  const claude = makeRequest('claude', 'Claude activity');
  const labs = new LabHost(db);
  expect(labs.open(claude).manifest.fallback).toBe('Claude activity');
  const opened = labs.open(codex);
  expect(opened.manifest.fallback).toBe('Codex activity');
  expect(() => labs.open({ ...claude, messageId: codex.messageId })).toThrow(/no longer available/);
  expect(() => labs.open({ ...codex, messageId: claude.messageId })).toThrow(/no longer available/);
  expect(listEvidence(db, address.conceptId)).toEqual([]);
  for (let seq = 1; seq < 4; seq++) labs.input({ session: opened.session, seq, input: { type: 'advance' } });
  const completed = labs.input({ session: opened.session, seq: 4, input: { type: 'reject' } });
  expect(completed.lesson?.messages[0]?.id).toBe(codex.messageId);
  expect(completed.lesson?.messages.at(-1)).toMatchObject({ role: 'system', text: 'Activity practice saved.' });
  expect(readLesson(db, claude).messages.map(entry => entry.id)).toEqual([claude.messageId]);
  expect(listEvidence(db, address.conceptId)).toMatchObject([{ source: 'environment', snapshotId }]);
});

describe('activity assessment', () => {
  it('keeps completed learning when a later activity is practised', () => {
    recordEvidence(db, { ...address, status: 'demonstrated', source: 'check', note: 'Completed checks.' });
    const labs = new LabHost(db);
    const opened = labs.open(openRequest());
    for (let seq = 1; seq <= 3; seq++) labs.input({ session: opened.session, seq, input: { type: 'advance' } });
    labs.input({ session: opened.session, seq: 4, input: { type: 'reject' } });
    expect(listEvidence(db, address.conceptId)).toMatchObject([{ source: 'check', status: 'demonstrated', revision: 1 }]);
  });

  it('does not replace portable evidence from another workspace', () => {
    const origin = addWorkspace(db, { kind: 'topic', title: 'Origin' });
    upsertConcept(db, { workspaceId: origin.id, key: 'lease', title: 'Lease', portable: true });
    recordEvidence(db, { workspaceId: origin.id, conceptId: address.conceptId, depth: address.depth,
      status: 'demonstrated', source: 'check', note: 'Previously demonstrated.' });
    switchWorkspace(db, address.workspaceId);
    const labs = new LabHost(db);
    const opened = labs.open(openRequest());
    for (let seq = 1; seq <= 3; seq++) labs.input({ session: opened.session, seq, input: { type: 'advance' } });
    const result = labs.input({ session: opened.session, seq: 4, input: { type: 'reject' } });
    expect(result.lesson?.messages.at(-1)).toMatchObject({ role: 'system', observation: expect.any(String) });
    expect(listEvidence(db, address.conceptId)[0]).toMatchObject({ workspaceId: origin.id, source: 'check', revision: 1 });
  });

  it('records pack assessment and makes its summary available to the next tutor preview', () => {
    save([block, { type: 'check', kind: 'prediction', prompt: 'Claim 8 has taken over. What can the writer accept?',
      options: ['Claim 7', 'Claim 8', 'Either claim', 'Both claims'], expected: 1 }]);
    const before = readLesson(db, address);
    const labs = new LabHost(db);
    const opened = labs.open(openRequest());
    for (let seq = 1; seq <= 3; seq++) labs.input({ session: opened.session, seq, input: { type: 'advance' } });
    const result = labs.input({ session: opened.session, seq: 4, input: { type: 'reject' } });
    expect(listEvidence(db, address.conceptId)).toMatchObject([
      { source: 'environment', status: 'partial', masteryVerified: false, workspaceId: address.workspaceId },
    ]);
    expect(result.lesson?.mastery).toEqual(before.mastery);
    const observation = result.lesson?.messages.at(-1)?.observation;
    expect(observation).toBeTruthy();
    const preview = prepareTurn(db, { ...address, provider: 'codex', intent: { kind: 'ask', text: 'What next?' } }).preview;
    expect(preview.prompt).toContain(observation);
  });

  it('rolls back evidence when the conversation cannot be saved', () => {
    const labs = new LabHost(db);
    const opened = labs.open(openRequest());
    for (let seq = 1; seq <= 3; seq++) labs.input({ session: opened.session, seq, input: { type: 'advance' } });
    db.exec("CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'message unavailable'); END");
    expect(() => labs.input({ session: opened.session, seq: 4, input: { type: 'reject' } })).toThrow(/message unavailable/);
    expect(listEvidence(db, address.conceptId)).toEqual([]);
    db.exec('DROP TRIGGER reject_message');
    expect(labs.input({ session: opened.session, seq: 4, input: { type: 'reject' } }).lesson).toBeTruthy();
  });
});

it.each([
  { pack: 'camera-exposure@1', parameters: { initialShutter: 500, initialIso: 800 }, action: 'capture' },
  { pack: 'network-builder@1', parameters: { clientPort: 'c', proxyInputPort: 'i', proxyOutputPort: 'o', servicePort: 's',
    initialLinks: [{ fromPort: 'c', toPort: 'i' }, { fromPort: 'o', toPort: 's' }] }, action: 'test' },
])('records only practice for a supplied solution to $pack', ({ pack, parameters, action }) => {
  save([{ ...block, pack, config: { pack, parameters } }]);
  const host = new LabHost(db);
  const { session } = host.open(openRequest());
  const result = host.input({ session, seq: 1, input: { type: action } });
  expect(listEvidence(db, address.conceptId)).toEqual([]);
  expect(result.lesson?.reused).toBe(false);
  expect(result.lesson?.messages.at(-1)).toMatchObject({ role: 'system', observation: expect.any(String) });
  expect(result.lesson?.messages.at(-1)?.recommendation).toBeUndefined();
});
