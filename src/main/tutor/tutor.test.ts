import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TutorIntent, TutorRequest } from '../../shared/reader';
import { addPrerequisite, upsertConcept } from '../db/concepts';
import { openDatabase, type Db } from '../db/connection';
import { seedDemoWorkspaces } from '../db/demo';
import { listEvidence, recordEvidence, resetEvidence } from '../db/evidence';
import { readWorkspaceGraph } from '../db/graph';
import { bindSnapshot, saveLesson } from '../db/lessons';
import { addWorkspace } from '../db/workspaces';
import { makeShimDir, makeTempDir, setupRunner } from '../providers/test-helpers';
import { readLesson, readerHandlers } from '../reader/ipc';
import { tutorSchemas } from './ipc';
import { prepareTurn, previewNewTopic } from './prompt';
import { createGenerator, type Generate, type TutorReply } from './provider';
import { TutorSession } from './session';

let db: Db;
let request: TutorRequest;
let session: TutorSession;
const explanation = { type: 'prose' as const, heading: 'Routing', text: 'The longest matching prefix wins.' };
const check = { type: 'check' as const, kind: 'short-answer' as const, prompt: 'Why use the longer match?', expected: ['It is more specific.'] };
const applied = { ...check, prompt: 'Which route wins for 10.2.3.4, and why?' };
const intermediate: TutorReply = { lesson: { schema: 'delve.lesson/1', blocks: [explanation, applied] }, assessment: true,
  observation: 'The learner identified specificity.', recommendation: null };
const opening: TutorReply = {
  lesson: { schema: 'delve.lesson/1', blocks: [explanation, check] }, assessment: null, recommendation: null, observation: null,
};

beforeEach(() => {
  vi.stubEnv('CODEX_HOME', join(tmpdir(), `delve-missing-${randomUUID()}`));
  db = openDatabase(':memory:');
  const workspaceId = addWorkspace(db, { kind: 'topic', title: 'Networking' }).id;
  const concept = upsertConcept(db, { key: 'routing', title: 'Routing', workspaceId, portable: true });
  request = { workspaceId, conceptId: concept.id, depth: 'medium', provider: 'codex', intent: { kind: 'teach' } };
  session = new TutorSession(db, async () => opening);
});

it('uses the Codex config model unless an explicit override wins, and binds the preview to its source', async () => {
  const home = await makeTempDir('codex-config');
  vi.stubEnv('CODEX_HOME', home);
  vi.stubEnv('DELVE_CODEX_MODEL', undefined);
  const defaults = prepareTurn(db, request);
  expect(defaults.preview).toMatchObject({ model: null, modelSource: 'default' });
  await writeFile(join(home, 'config.toml'), 'model = "gpt-6.1-terra"\n[mcp_servers.bad]\ncommand = "ignored"\n');
  const configured = prepareTurn(db, request);
  expect(configured.preview).toMatchObject({ model: 'gpt-6.1-terra', modelSource: 'codex-config' });
  expect(configured.preview.token).not.toBe(defaults.preview.token);
  const record = join(home, 'record.json');
  const { runner } = await setupRunner(await makeShimDir(), { FAKE_PROVIDER_RECORD: record,
    FAKE_PROVIDER_PAYLOAD: JSON.stringify({ ...opening, lesson: { ...opening.lesson, source: null } }) });
  await createGenerator(runner)(configured, new AbortController().signal);
  const argv: string[] = JSON.parse(await readFile(record, 'utf8')).argv;
  expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'gpt-6.1-terra']);
  expect(argv).toContain('--ignore-user-config');
  vi.stubEnv('DELVE_CODEX_MODEL', 'gpt-override');
  expect(prepareTurn(db, request).preview).toMatchObject({ model: 'gpt-override', modelSource: 'override' });
});

it.each(['model = "--bad"', 'model = 123', '[profile]\nmodel = "nested"', 'model = ['])(
  'falls back to the Codex default for invalid or absent top-level model: %s', async contents => {
    const home = await makeTempDir('codex-invalid');
    vi.stubEnv('CODEX_HOME', home);
    vi.stubEnv('DELVE_CODEX_MODEL', undefined);
    await writeFile(join(home, 'config.toml'), contents);
    expect(prepareTurn(db, request).preview).toMatchObject({ model: null, modelSource: 'default' });
  },
);
afterEach(() => { session.close(); db.close(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function run(intent: TutorIntent, base = request) {
  const next = { ...base, intent };
  const { token } = prepareTurn(db, next).preview;
  return session.run({ ...next, token, requestId: randomUUID() });
}

it('previews a new topic before creating its workspace and matches the first tokenized turn', () => {
  const input = { title: '  Café   acoustics ', depth: 'low', provider: 'codex' } as const;
  const preview = previewNewTopic(input);
  expect(preview).not.toHaveProperty('token');
  expect(preview.prompt).toContain('Café acoustics');
  expect(preview.bytes).toBe(Buffer.byteLength(preview.prompt));
  expect(db.prepare('SELECT count(*) AS count FROM workspaces').get()?.count).toBe(1);
  const workspace = addWorkspace(db, { kind: 'topic', title: input.title });
  const conceptId = readerHandlers(db)['reader:start-topic']({ workspaceId: workspace.id });
  const actual = prepareTurn(db, { ...request, workspaceId: workspace.id, conceptId, depth: input.depth }).preview;
  expect(actual).toMatchObject(preview);
  expect(actual.token).toMatch(/^[a-f0-9]{64}$/);
});

it('previews the exact UTF-8 prompt, chosen depth, known prerequisites and most recent answer', async () => {
  const known = upsertConcept(db, { key: 'ip', title: 'IP addresses', workspaceId: request.workspaceId, portable: true });
  addPrerequisite(db, request.conceptId, known.id);
  recordEvidence(db, { ...request, conceptId: known.id, source: 'check', status: 'demonstrated', masteryVerified: true });
  recordEvidence(db, { ...request, source: 'environment', status: 'partial', note: 'Chose the default route despite a subnet match.' });
  const calls: string[] = [];
  const generate: Generate = async turn => {
    calls.push(turn.preview.prompt);
    if (!turn.response) return opening;
    return intermediate;
  };
  session = new TutorSession(db, generate);
  const preview = prepareTurn(db, request).preview;
  expect(preview.prompt).toContain('IP addresses');
  expect(preview.prompt).toContain('"depth": "medium"');
  expect(preview.files).toEqual([]);
  expect(preview.prompt).toContain('Chose the default route despite a subnet match.');
  const lesson = await run(request.intent);
  expect(calls[0]).toBe(preview.prompt);
  expect(Buffer.byteLength(calls[0]!)).toBe(preview.bytes);
  expect(lesson.blocks[1]).not.toHaveProperty('expected');
  const answer = await run({ kind: 'answer', revision: lesson.mastery.revision!, answer: 'A narrower prefix identifies a smaller network.' });
  expect(answer.messages).toMatchObject([{ role: 'learner' }, { role: 'tutor', observation: expect.stringContaining('specificity') }]);
  expect(answer.mastery).toMatchObject({ stage: 'checking', correctAnswers: 1 });
  expect(listEvidence(db, request.conceptId)).toMatchObject([{ status: 'partial' }]);
  const follow = prepareTurn(db, { ...request, intent: { kind: 'ask', text: 'What about IPv6?' } });
  expect(follow.preview.prompt).toContain('smaller network');
  expect(follow.preview.prompt).toContain('identified specificity');
  expect(follow.preview.prompt).toContain('What about IPv6?');
});

it('reuses only a demonstrated canonical concept at the selected depth, preserving transferred origins', async () => {
  const origin = addWorkspace(db, { kind: 'topic', title: 'IP' });
  upsertConcept(db, { key: 'routing', title: 'Routing', portable: true, workspaceId: origin.id });
  recordEvidence(db, { ...request, workspaceId: origin.id, status: 'demonstrated', source: 'check', masteryVerified: true });
  const generate = vi.fn<Generate>(async () => opening);
  session = new TutorSession(db, generate);
  expect(await run(request.intent)).toMatchObject({ reused: true, blocks: [], messages: [] });
  expect(generate).not.toHaveBeenCalled();
  expect((await run(request.intent, { ...request, depth: 'low' })).reused).toBe(false);
  expect(generate).toHaveBeenCalledOnce();
  const other = upsertConcept(db, { key: 'routing', title: 'Routing', portable: false, workspaceId: request.workspaceId });
  expect(readLesson(db, { ...request, conceptId: other.id }).reused).toBe(false);
  expect(listEvidence(db, request.conceptId)[0]?.workspaceId).toBe(origin.id);
});

it('retains verified local mastery when the source snapshot changes', async () => {
  await run(request.intent);
  recordEvidence(db, { ...request, status: 'demonstrated', source: 'check', masteryVerified: true });
  bindSnapshot(db, request.workspaceId, 'abcd002');
  expect(readLesson(db, request).mastery.stage).toBe('understood');
  expect(readWorkspaceGraph(db, request.workspaceId).evidence[0]?.status).toBe('demonstrated');
});

it('uses the cache only for matching model, provider, depth and snapshot', async () => {
  vi.stubEnv('DELVE_CODEX_MODEL', undefined);
  vi.stubEnv('DELVE_CLAUDE_MODEL', undefined);
  const generate = vi.fn<Generate>(async () => opening);
  session = new TutorSession(db, generate);
  await run(request.intent);
  await run(request.intent);
  expect(generate).toHaveBeenCalledOnce();
  vi.stubEnv('DELVE_CODEX_MODEL', 'another-model');
  await run(request.intent);
  await run(request.intent, { ...request, provider: 'claude' });
  await run(request.intent, { ...request, depth: 'low' });
  bindSnapshot(db, request.workspaceId, 'abcd001');
  await run(request.intent);
  expect(generate).toHaveBeenCalledTimes(5);
});

it.each([
  { provider: 'codex', variable: 'DELVE_CODEX_MODEL', model: 'gpt-5.4' },
  { provider: 'claude', variable: 'DELVE_CLAUDE_MODEL', model: 'claude-sonnet-4-6' },
] as const)('previews the $provider default and sends the consented model selection', async ({ provider, variable, model }) => {
  const record = join(await makeTempDir('tutor-model'), 'request.json');
  const { runner } = await setupRunner(await makeShimDir(), {
    FAKE_PROVIDER_RECORD: record,
    FAKE_PROVIDER_PAYLOAD: JSON.stringify({ ...opening, lesson: { ...opening.lesson, source: null } }),
  });
  const generate = createGenerator(runner);
  const { signal } = new AbortController();
  vi.stubEnv(variable, undefined);
  const input = { ...request, provider };
  const defaults = prepareTurn(db, input);
  expect(defaults.preview.model).toBeNull();
  await generate(defaults, signal);
  const defaultCall = JSON.parse(await readFile(record, 'utf8'));
  expect(defaultCall.argv).not.toContain('--model');
  expect(defaultCall.stdin).toBe(defaults.preview.prompt);

  vi.stubEnv(variable, model);
  const override = prepareTurn(db, input);
  expect(override.preview.model).toBe(model);
  expect(override.cacheKey).not.toBe(defaults.cacheKey);
  expect(() => session.run({ ...input, requestId: randomUUID(), token: defaults.preview.token })).toThrow(/changed/);
  await generate(override, signal);
  const overrideCall = JSON.parse(await readFile(record, 'utf8'));
  const modelFlag = overrideCall.argv.indexOf('--model');
  expect(overrideCall.argv.slice(modelFlag, modelFlag + 2)).toEqual(['--model', model]);
  expect(overrideCall.stdin).toBe(override.preview.prompt);
});

it('preserves a valid lesson and transcript on invalid output and rejects stale or mismatched requests', async () => {
  const previous = await run(request.intent);
  session = new TutorSession(db, async () => opening);
  await expect(run({ kind: 'ask', text: 'Why?' })).rejects.toThrow(/outside the active lesson sequence/);
  expect(readLesson(db, request)).toEqual(previous);
  const old = prepareTurn(db, request).preview;
  bindSnapshot(db, request.workspaceId, 'abcd001');
  expect(() => session.run({ ...request, requestId: randomUUID(), token: old.token })).toThrow(/changed/);
  expect(() => prepareTurn(db, { ...request, provider: 'demo' })).toThrow(/provider for this workspace/);
  expect(tutorSchemas['tutor:preview'].safeParse({ ...request, files: ['/etc/passwd'] }).success).toBe(false);
  expect(tutorSchemas['tutor:run'].safeParse({ ...request, token: 'approved', requestId: randomUUID() }).success).toBe(false);
});

it('coalesces duplicate requests, cancels a subscriber independently and commits the result once', async () => {
  let release!: (reply: TutorReply) => void;
  const generate = vi.fn<Generate>(() => new Promise(resolve => { release = resolve; }));
  session = new TutorSession(db, generate);
  const firstId = randomUUID();
  const ask = { ...request, intent: { kind: 'ask' as const, text: 'How does this work?' } };
  const { token } = prepareTurn(db, ask).preview;
  const first = session.run({ ...ask, token, requestId: firstId });
  const second = session.run({ ...ask, token, requestId: randomUUID() });
  expect(generate).toHaveBeenCalledOnce();
  expect(() => run(request.intent)).toThrow(/current tutor response/);
  expect(session.cancel(firstId)).toBe(true);
  await expect(first).rejects.toThrow(/cancelled/);
  expect(generate.mock.calls[0]?.[1].aborted).toBe(false);
  release({ ...opening, lesson: { ...opening.lesson, blocks: [explanation] } });
  expect((await second).messages).toHaveLength(2);
  expect(readLesson(db, ask).messages).toHaveLength(2);
});

it('discards late output after cancellation or a change to the previewed context', async () => {
  let release!: (reply: TutorReply) => void;
  session = new TutorSession(db, () => new Promise(resolve => { release = resolve; }));
  const id = randomUUID();
  const { token } = prepareTurn(db, request).preview;
  const cancelled = session.run({ ...request, token, requestId: id });
  expect(session.cancel(id)).toBe(true);
  await expect(cancelled).rejects.toThrow(/cancelled/);
  release(opening);
  await Promise.resolve();
  expect(readLesson(db, request).blocks).toEqual([]);
  const stale = run(request.intent);
  bindSnapshot(db, request.workspaceId, 'cdef123');
  release(opening);
  await expect(stale).rejects.toThrow(/changed/);
  expect(readLesson(db, request).blocks).toEqual([]);
});

it('the offline provider reteaches a miss, offers fresh applied checks and recommends a path after understanding', async () => {
  seedDemoWorkspaces(db);
  session = new TutorSession(db);
  const workspaceId = 'de100000-0000-4000-8000-000000000001';
  const graph = readWorkspaceGraph(db, workspaceId);
  const lease = graph.concepts.find(c => c.title === 'Worker leases')!;
  request = { ...request, workspaceId, conceptId: lease.id, provider: 'demo' };
  const lesson = readLesson(db, request);
  expect(lesson.mastery.activeCheck?.kind).toBe('recognition');
  const asked = await run({ kind: 'ask', text: 'Draw a system trace' });
  expect(asked.messages[1]?.blocks?.some(b => b.type === 'diagram')).toBe(true);
  expect(asked.mastery).toEqual(lesson.mastery);
  const wrong = await run({ kind: 'answer', revision: lesson.mastery.revision!, answer: 0 });
  expect(wrong.messages.at(-1)).toMatchObject({ text: expect.stringContaining('incorrect'),
    observation: expect.stringContaining('first to report') });
  expect(wrong.messages.at(-1)?.recommendation).toBeUndefined();
  expect(readWorkspaceGraph(db, workspaceId).suggestions).toBeUndefined();
  const correct = await run({ kind: 'answer', revision: wrong.mastery.revision!, answer: 'Reject the stale generation.' });
  expect(correct.mastery).toMatchObject({ correctAnswers: 1, activeCheck: { kind: 'applied' } });
  expect(correct.mastery.activeCheck?.prompt).not.toBe(wrong.mastery.activeCheck?.prompt);
  expect(listEvidence(db, lease.id)).toMatchObject([{ status: 'partial' }]);
  const understood = await run({ kind: 'answer', revision: correct.mastery.revision!, answer: 'Compare the active generation.' });
  expect(understood.mastery).toMatchObject({ stage: 'understood', activeCheck: null });
  expect(understood.messages.at(-1)?.recommendation?.action).toBe('Explore Recovery');
  expect(readWorkspaceGraph(db, workspaceId).suggestions?.medium?.conceptId).toBe(graph.concepts.find(c => c.title === 'Recovery')?.id);
  expect(listEvidence(db, lease.id)).toMatchObject([{ status: 'demonstrated' }]);
  const review = await run({ kind: 'review', revision: understood.mastery.revision! });
  expect(review.mastery).toMatchObject({ stage: 'checking', attempts: 0, correctAnswers: 0, activeCheck: { kind: 'applied' } });
  expect(review.messages.at(-1)?.blocks?.some(block => block.type === 'check')).toBe(false);
  expect(readWorkspaceGraph(db, workspaceId).suggestions).toBeUndefined();
  expect(listEvidence(db, lease.id)).toMatchObject([{ status: 'demonstrated' }]);
  resetEvidence(db, lease.id, { depth: 'medium', workspaceId });
  expect(readLesson(db, request).mastery).toMatchObject({ stage: 'checking', attempts: 0, activeCheck: { kind: 'recognition' } });
  expect(() => run({ kind: 'answer', revision: lesson.mastery.revision!, answer: 1 })).toThrow(/current check/);
  expect(listEvidence(db, lease.id)).toEqual([]);
});

it('refuses stale answers and rolls back evidence with the exchange if a message cannot be saved', async () => {
  const lesson = await run(request.intent);
  const intent = { kind: 'answer' as const, revision: lesson.mastery.revision!, answer: 'Specific routing.' };
  session = new TutorSession(db, async () => intermediate);
  db.exec(`CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'write refused'); END`);
  await expect(run(intent)).rejects.toThrow(/write refused/);
  expect(listEvidence(db, request.conceptId)).toEqual([]);
  expect(readLesson(db, request).messages).toEqual([]);
  saveLesson(db, { ...request, model: 'new', provider: 'codex', cacheKey: 'new', schemaVersion: 'delve.lesson/1',
    body: { schema: 'delve.lesson/1', blocks: [explanation] } });
  expect(() => run(intent)).toThrow(/current check/);
});

it('regenerates an invalid latest opening and preserves the fallback if the retry fails', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const previous = await run(request.intent);
  saveLesson(db, { ...request, provider: 'codex', model: 'old', schemaVersion: 'delve.lesson/1', cacheKey: 'invalid',
    body: { schema: 'delve.lesson/1', blocks: [{ type: 'prose', heading: 'Missing text' }] } });
  expect(readLesson(db, request)).toMatchObject({ invalidLatest: true, revision: previous.revision });
  session = new TutorSession(db, async () => { throw new Error('Provider unavailable'); });
  await expect(run(request.intent)).rejects.toThrow('Provider unavailable');
  expect(readLesson(db, request)).toMatchObject({ invalidLatest: true, revision: previous.revision });
  session = new TutorSession(db, async () => ({ ...opening, lesson: { ...opening.lesson, blocks: [{ ...explanation, heading: 'Revised explanation' }, check] } }));
  expect(await run(request.intent)).toMatchObject({ invalidLatest: false, blocks: [{ heading: 'Revised explanation' }, { type: 'check' }] });
});

it('runs an opening, a miss and two applied passes through the fake CLI', async () => {
  const responseFile = join(await makeTempDir('mastery-cli'), 'response.json');
  const { runner } = await setupRunner(await makeShimDir(), { FAKE_PROVIDER_RESPONSE_FILE: responseFile });
  session = new TutorSession(db, createGenerator(runner));
  const send = async (intent: TutorIntent, reply: TutorReply) => {
    await writeFile(responseFile, JSON.stringify({ ...reply, lesson: { ...reply.lesson, source: null } }));
    return run(intent);
  };
  const choice = { type: 'check' as const, kind: 'choice' as const, prompt: 'Which prefix wins?', options: ['/8', '/24'], expected: 1 };
  const lesson = await send(request.intent, { ...opening, lesson: { ...opening.lesson, blocks: [explanation, choice] } });
  const miss = await send({ kind: 'answer', revision: lesson.mastery.revision!, answer: 0 }, {
    ...intermediate, assessment: false, observation: 'The /8 covers a broader range.',
  });
  expect(miss.mastery).toMatchObject({ stage: 'checking', attempts: 1, correctAnswers: 0 });
  const first = await send({ kind: 'answer', revision: miss.mastery.revision!, answer: 'The destination matches the narrower CIDR.' }, {
    ...intermediate, lesson: { ...opening.lesson, blocks: [explanation, { ...applied,
      prompt: 'If the /24 is withdrawn, explain which of the remaining prefixes carries the packet.' }] },
  });
  expect(first.mastery).toMatchObject({ stage: 'checking', attempts: 2, correctAnswers: 1 });
  expect(readWorkspaceGraph(db, request.workspaceId).evidence[0]?.status).toBe('partial');
  const complete = await send({ kind: 'answer', revision: first.mastery.revision!, answer: 'The /8 is the longest surviving match.' }, {
    ...intermediate, lesson: { ...opening.lesson, blocks: [explanation] },
    recommendation: { action: 'Try another case', reason: 'You chose the best remaining match.', targetId: null },
  });
  expect(complete.mastery).toMatchObject({ stage: 'understood', attempts: 3, correctAnswers: 2, activeCheck: null });
  expect(listEvidence(db, request.conceptId)).toMatchObject([{ status: 'demonstrated', masteryVerified: true }]);
});

it('persists the low-depth cycle and budget across restarts, then supports review and skip', async () => {
  session.close();
  db.close();
  const file = join(await makeTempDir('mastery-db'), 'delve.sqlite');
  db = openDatabase(file);
  seedDemoWorkspaces(db);
  const workspaceId = 'de100000-0000-4000-8000-000000000001';
  const lease = readWorkspaceGraph(db, workspaceId).concepts.find(c => c.title === 'Worker leases')!;
  request = { ...request, workspaceId, conceptId: lease.id, depth: 'low', provider: 'demo' };
  session = new TutorSession(db);
  const opening = readLesson(db, request);
  expect(opening.mastery).toMatchObject({ requiredCorrectAnswers: 3, maxAttempts: 6 });
  let lesson = await run({ kind: 'answer', revision: opening.mastery.revision!, answer: 0 });
  expect(lesson.mastery).toMatchObject({ attempts: 1, correctAnswers: 1, activeCheck: { kind: 'applied' } });
  session.close();
  db.close();
  db = openDatabase(file);
  session = new TutorSession(db);
  expect(readLesson(db, request)).toEqual(lesson);
  expect(() => run({ kind: 'answer', revision: opening.mastery.revision!, answer: 0 })).toThrow(/current check/);
  const prompts = new Set([opening.mastery.activeCheck!.prompt]);
  while (lesson.mastery.stage === 'checking') {
    const { prompt } = lesson.mastery.activeCheck!;
    expect(prompts.has(prompt)).toBe(false);
    prompts.add(prompt);
    lesson = await run({ kind: 'answer', revision: lesson.mastery.revision!, answer: 'The first writer always wins.' });
  }
  expect(lesson.mastery).toMatchObject({ stage: 'review', attempts: 6, correctAnswers: 0, activeCheck: null });
  expect(readWorkspaceGraph(db, workspaceId).evidence.find(e => e.conceptId === lease.id)?.status).toBe('partial');
  const review = await run({ kind: 'review', revision: lesson.mastery.revision! });
  expect(review.mastery).toMatchObject({ stage: 'checking', attempts: 0, correctAnswers: 0, activeCheck: { kind: 'applied' } });
  expect(prompts.has(review.mastery.activeCheck!.prompt)).toBe(false);
  const skipped = readerHandlers(db)['reader:skip']({ ...request, revision: review.mastery.revision! });
  expect(skipped.mastery).toMatchObject({ stage: 'skipped', activeCheck: null });
  session.close();
  db.close();
  db = openDatabase(file);
  session = new TutorSession(db);
  expect(readLesson(db, request).mastery).toEqual(skipped.mastery);
  expect(listEvidence(db, lease.id)).toMatchObject([{ status: 'partial', masteryVerified: false }]);
});

it('rejects repeated checks, early recommendations and trace-only visual replies without changing the active check', async () => {
  recordEvidence(db, { ...request, status: 'demonstrated', source: 'check' });
  const opened = await run(request.intent);
  const answer = { kind: 'answer' as const, revision: opened.mastery.revision!, answer: 'It is more specific.' };
  expect(opened.mastery.stage).toBe('checking');
  expect(readWorkspaceGraph(db, request.workspaceId).evidence[0]?.status).toBe('revisit');
  session = new TutorSession(db, async () => ({
    ...intermediate, lesson: { ...opening.lesson, blocks: [explanation, { ...check, prompt: 'WHY use the longer match!' }] },
  }));
  await expect(run(answer)).rejects.toThrow(/fresh written applied check/);
  session = new TutorSession(db, async () => ({
    ...intermediate, recommendation: { targetId: null, action: 'Move on', reason: 'The answer was correct.' },
  }));
  await expect(run(answer)).rejects.toThrow(/before the lesson was understood or skipped/);
  session = new TutorSession(db, async () => ({
    ...opening, lesson: { ...opening.lesson, blocks: [{ type: 'trace', steps: ['Before', 'After'] }] },
  }));
  await expect(run({ kind: 'ask', text: 'Draw a diagram' })).rejects.toThrow(/diagram with connected nodes/);
  expect(readLesson(db, request)).toEqual(opened);
});

it('identifies visual requests without treating every use of draw as a diagram request', () => {
  const ask = (text: string) => prepareTurn(db, { ...request, intent: { kind: 'ask', text } });
  expect(ask('Show some diagrams').needsDiagram).toBe(true);
  expect(ask('Explain this visually').preview.prompt).toContain('"visualRequired": true');
  expect(ask('Draw the flow').needsDiagram).toBe(true);
  expect(ask('A visualization, please').needsDiagram).toBe(true);
  expect(ask('Draw a conclusion from this').needsDiagram).toBe(false);
});

it('rejects a pending answer after the learner skips the lesson', async () => {
  const opened = await run(request.intent);
  let resolve!: (reply: TutorReply) => void;
  session = new TutorSession(db, () => new Promise(done => { resolve = done; }));
  const revision = opened.mastery.revision!;
  const pending = run({ kind: 'answer', revision, answer: 'Specificity.' });
  const skipped = readerHandlers(db)['reader:skip']({ ...request, revision });
  resolve(intermediate);
  await expect(pending).rejects.toThrow(/current check/);
  expect(readLesson(db, request)).toEqual(skipped);
  expect(listEvidence(db, request.conceptId)).toEqual([]);
});
