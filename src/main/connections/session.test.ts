import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_OVERRIDE_ENV } from '../providers/env';
import { ConnectionSession, type ConnectionRunRequest } from './session';
import type { ConnectionScope } from './prompt';

const first = { id: 1, title: 'Lease generations', summary: 'Distinguish owners across time.' };
const second = { id: 2, title: 'Frame counters', summary: 'Detect stale frames.' };
const third = { id: 3, title: 'Previously linked', summary: 'Excluded private summary.' };
const suggestion = { fromConceptId: 1, toConceptId: 2, reason: 'Both use a counter to distinguish stale state.' };
const request = { provider: 'claude', conceptId: 1 } as const;

function setup(value: unknown = { suggestions: [suggestion] }) {
  const scope: ConnectionScope = { anchor: first, candidates: [first, second, third], linkedConceptIds: [third.id] };
  const loadScope = vi.fn<(_id: number) => ConnectionScope | null>().mockReturnValue(scope);
  const run = vi.fn().mockResolvedValue({ provider: 'claude', model: 'example-model', value, attempts: 1 });
  vi.stubEnv(MODEL_OVERRIDE_ENV.claude, 'example-model');
  return { scope, loadScope, run, session: new ConnectionSession(loadScope, { run }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('connection consent', () => {
  it('sends the exact approved prompt and schema once with the selected model', async () => {
    const { session, run } = setup();
    const preview = session.preview(request);
    expect(run).not.toHaveBeenCalled();
    expect(preview).toMatchObject({ provider: 'claude', model: 'example-model', modelSource: 'override', files: [] });
    expect(preview.bytes).toBe(Buffer.byteLength(preview.prompt));
    expect(preview.prompt).toContain(second.summary);
    expect(preview.prompt).not.toContain(third.summary);
    vi.stubEnv(MODEL_OVERRIDE_ENV.claude, 'different-model');
    const consent = { token: preview.token, consent: true } as const;
    const pending = session.run(consent);
    await expect(session.run(consent)).rejects.toMatchObject({ code: 'STALE_CONNECTION_PREVIEW' });
    await expect(pending).resolves.toStrictEqual({
      provenance: { provider: 'claude', model: 'example-model', modelSource: 'override' },
      suggestions: [suggestion],
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude', model: 'example-model', prompt: preview.prompt, jsonSchema: JSON.parse(preview.outputSchema),
      maxRetries: 0,
    }));
  });

  it('rejects missing consent, a different token and prompt fields supplied by the caller', async () => {
    const { session, run } = setup();
    const { token } = session.preview(request);
    for (const input of [{ token }, { token, consent: false }, { token, consent: true, prompt: 'different content' }]) {
      await expect(session.run(input as ConnectionRunRequest)).rejects.toHaveProperty('name', 'ZodError');
    }
    await expect(session.run({ token: randomUUID(), consent: true })).rejects.toMatchObject({ code: 'STALE_CONNECTION_PREVIEW' });
    expect(run).not.toHaveBeenCalled();
  });

  it('requires a new review if the subject data changes or the preview expires', async () => {
    const { session, run, scope, loadScope } = setup();
    const { token } = session.preview(request);
    loadScope.mockReturnValueOnce({ ...scope, candidates: [{ ...second, summary: 'Updated description' }] });
    await expect(session.run({ token, consent: true })).rejects.toMatchObject({ code: 'STALE_CONNECTION_PREVIEW' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
    const expiring = session.preview(request);
    clock.mockReturnValue(10 * 60_000 + 1);
    await expect(session.run({ token: expiring.token, consent: true })).rejects.toMatchObject({ code: 'STALE_CONNECTION_PREVIEW' });
    expect(run).not.toHaveBeenCalled();
  });

  it('invalidates previews on replacement or dismissal', async () => {
    const { session, run } = setup();
    const firstPreview = session.preview(request);
    const secondPreview = session.preview(request);
    await expect(session.run({ token: firstPreview.token, consent: true })).rejects.toMatchObject({ code: 'STALE_CONNECTION_PREVIEW' });
    session.clearPreview();
    await expect(session.run({ token: secondPreview.token, consent: true })).rejects.toMatchObject({ code: 'STALE_CONNECTION_PREVIEW' });
    expect(run).not.toHaveBeenCalled();
  });

  it('does not start an already cancelled request', async () => {
    const { session, run } = setup();
    const { token } = session.preview(request);
    await expect(session.run({ token, consent: true }, AbortSignal.abort())).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('connection replies', () => {
  it.each([
    ['unknown endpoint', [{ ...suggestion, toConceptId: 999 }]],
    ['linked endpoint', [{ ...suggestion, toConceptId: 3 }]],
    ['self-link', [{ ...suggestion, toConceptId: 1 }]],
    ['unrelated anchor', [{ ...suggestion, fromConceptId: 3 }]],
    ['duplicate pair', [suggestion, suggestion]],
    ['invalid ID type', [{ ...suggestion, toConceptId: '2' }]],
    ['missing reason', [{ fromConceptId: 1, toConceptId: 2 }]],
    ['blank reason', [{ ...suggestion, reason: '  ' }]],
    ['long reason', [{ ...suggestion, reason: 'x'.repeat(401) }]],
    ['overlong padded reason', [{ ...suggestion, reason: ' '.repeat(400) + 'x' }]],
    ['extra fields', [{ ...suggestion, provider: 'codex' }]],
    ['too many suggestions', Array.from({ length: 6 }, () => suggestion)],
  ])('rejects an invalid reply with %s', async (_label, suggestions) => {
    const { session } = setup({ suggestions });
    const { token } = session.preview(request);
    await expect(session.run({ token, consent: true })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
  });

  it('accepts an empty set of suggestions with provider provenance', async () => {
    const { session } = setup({ suggestions: [] });
    const { token } = session.preview(request);
    await expect(session.run({ token, consent: true })).resolves.toMatchObject({
      provenance: { provider: 'claude', model: 'example-model' },
      suggestions: [],
    });
  });

  it('rejects a known concept that did not fit within the preview budget', async () => {
    const candidates = Array.from({ length: 45 }, (_, index) => ({
      id: index + 100, title: '🌐'.repeat(100), summary: '\x00'.repeat(700),
    }));
    const { session, scope, loadScope } = setup({ suggestions: [{ ...suggestion, toConceptId: 144 }] });
    loadScope.mockReturnValue({ ...scope, candidates });
    const preview = session.preview(request);
    expect(preview.bytes).toBe(Buffer.byteLength(preview.prompt));
    expect(preview.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(preview.prompt).toContain('"id":100');
    expect(preview.prompt).not.toContain('"id":144');
    await expect(session.run({ token: preview.token, consent: true })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
  });
});
