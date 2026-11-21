import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { upsertConcept } from '../db/concepts';
import { openDatabase, transaction, type Db } from '../db/connection';
import { listEvidence, recordEvidence } from '../db/evidence';
import { saveLesson } from '../db/lessons';
import { addWorkspace, switchWorkspace } from '../db/workspaces';
import { readLesson } from '../reader/ipc';
import { appendEntries } from '../reader/conversation';
import { lessonContext } from '../reader/stored-lesson';
import { documentSchema } from '../reader/document';
import { prepareTurn } from '../tutor/prompt';
import { labHandlers } from './host';
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
    const labs = labHandlers(db);
    const request = openRequest();
    const opened = labs['lab:open'](request);
    expect(opened.config.pack).toBe('lease-handoff@1');
    expect(() => labs['lab:input']({ session: opened.session, seq: 2, input: { type: 'reset' } })).toThrow(/order/);
    expect(labs['lab:input']({ session: opened.session, seq: 1, input: { type: 'reset' } }).state).toBeTruthy();
    expect(() => labs['lab:input']({ session: opened.session, seq: 1, input: { type: 'reset' } })).toThrow(/order/);
    const other = addWorkspace(db, { kind: 'topic', title: 'Other' });
    expect(() => labs['lab:input']({ session: opened.session, seq: 2, input: { type: 'reset' } })).toThrow(/workspace/);
    switchWorkspace(db, address.workspaceId);
    save([{ ...block, fallback: 'A changed activity.' }]);
    expect(() => labs['lab:open'](request)).toThrow(/changed/);
    expect(() => labs['lab:input']({ session: opened.session, seq: 2, input: { type: 'reset' } })).toThrow(/changed/);
    expect(labs['lab:close']({ session: opened.session })).toBe(true);
    expect(labs['lab:close']({ session: opened.session })).toBe(false);
    expect(other.id).not.toBe(address.workspaceId);
  });

  it('expires sessions and validates request shape', () => {
    vi.useFakeTimers();
    const labs = labHandlers(db);
    const opened = labs['lab:open'](openRequest());
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(() => labs['lab:input']({ session: opened.session, seq: 1, input: { type: 'reset' } })).toThrow(/expired/);
    expect(labSchemas['lab:open'].safeParse({ ...openRequest(), blockIndex: -1 }).success).toBe(false);
    expect(labSchemas['lab:input'].safeParse({ session: opened.session, seq: 0, input: {} }).success).toBe(false);
  });

  it('opens a scoped follow-up bundle only when its source hash matches', () => {
    const source = 'function step(initial, action) { return {text: initial, controls: [], marks: []}; }';
    const config = { pack: 'bundle@1', bundle: { apiVersion: 'delve.view/1', entry: 'step', source,
      sha256: createHash('sha256').update(source).digest('hex') }, parameters: { title: 'Practice', initial: '' } };
    const lesson = documentSchema.parse({ schema: 'delve.lesson/1', blocks: [{ type: 'environment', config, fallback: 'Try it.' }] });
    const [message] = transaction(db, () => appendEntries(db, lessonContext(db, address), null,
      [{ role: 'tutor', text: 'Try this.', lesson }]));
    const labs = labHandlers(db);
    const request = { ...openRequest(), messageId: message!.id };
    const opened = labs['lab:open'](request);
    expect(opened.state).toBeNull();
    expect(() => labs['lab:input']({ session: opened.session, seq: 1, input: {} })).toThrow(/practice only/);
    expect(() => labs['lab:open']({ ...request, messageId: message!.id + 1 })).toThrow(/available/);
    save([{ type: 'environment', config: { ...config, bundle: { ...config.bundle, sha256: '0'.repeat(64) } } }]);
    expect(() => labs['lab:open'](openRequest())).toThrow(/integrity/);
    expect(listEvidence(db, address.conceptId)).toEqual([]);
  });
});

describe('activity assessment', () => {
  it('does not replace portable evidence from another workspace', () => {
    const origin = addWorkspace(db, { kind: 'topic', title: 'Origin' });
    upsertConcept(db, { workspaceId: origin.id, key: 'lease', title: 'Lease', portable: true });
    recordEvidence(db, { workspaceId: origin.id, conceptId: address.conceptId, depth: address.depth,
      status: 'demonstrated', source: 'check', note: 'Previously demonstrated.' });
    switchWorkspace(db, address.workspaceId);
    const labs = labHandlers(db);
    const opened = labs['lab:open'](openRequest());
    for (let seq = 1; seq <= 3; seq++) labs['lab:input']({ session: opened.session, seq, input: { type: 'advance' } });
    const result = labs['lab:input']({ session: opened.session, seq: 4, input: { type: 'reject' } });
    expect(result.lesson?.messages.at(-1)).toMatchObject({ role: 'system', observation: expect.any(String) });
    expect(listEvidence(db, address.conceptId)[0]).toMatchObject({ workspaceId: origin.id, source: 'check', revision: 1 });
  });

  it('records pack assessment and makes its summary available to the next tutor preview', () => {
    const labs = labHandlers(db);
    const opened = labs['lab:open'](openRequest());
    for (let seq = 1; seq <= 3; seq++) labs['lab:input']({ session: opened.session, seq, input: { type: 'advance' } });
    const result = labs['lab:input']({ session: opened.session, seq: 4, input: { type: 'reject' } });
    expect(listEvidence(db, address.conceptId)).toMatchObject([{ source: 'environment', status: 'demonstrated', workspaceId: address.workspaceId }]);
    const observation = result.lesson?.messages.at(-1)?.observation;
    expect(observation).toBeTruthy();
    const preview = prepareTurn(db, { ...address, provider: 'codex', intent: { kind: 'ask', text: 'What next?' } }).preview;
    expect(preview.prompt).toContain(observation);
  });

  it('rolls back evidence when the conversation cannot be saved', () => {
    const labs = labHandlers(db);
    const opened = labs['lab:open'](openRequest());
    for (let seq = 1; seq <= 3; seq++) labs['lab:input']({ session: opened.session, seq, input: { type: 'advance' } });
    db.exec("CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'message unavailable'); END");
    expect(() => labs['lab:input']({ session: opened.session, seq: 4, input: { type: 'reject' } })).toThrow(/message unavailable/);
    expect(listEvidence(db, address.conceptId)).toEqual([]);
    db.exec('DROP TRIGGER reject_message');
    expect(labs['lab:input']({ session: opened.session, seq: 4, input: { type: 'reject' } }).lesson).toBeTruthy();
  });
});
