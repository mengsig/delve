import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PROVIDER_IDS, type ProviderId } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import { cancelledError, invalidOutputError } from '../providers/errors';
import { selectModel } from '../providers/model';
import type { RunRequest, RunResult } from '../providers/runner';
import { MAX_REASON_LENGTH, MAX_SUGGESTIONS, prepareConnectionScope, type ConnectionScope } from './prompt';

const conceptId = z.int().positive();
export const connectionSchemas = {
  'connections:preview': z.strictObject({ provider: z.enum(PROVIDER_IDS), conceptId }),
  'connections:run': z.strictObject({ token: z.uuid(), consent: z.literal(true) }),
};

const replySchema = z.strictObject({
  suggestions: z.array(z.strictObject({
    fromConceptId: conceptId,
    toConceptId: conceptId,
    reason: z.string().max(MAX_REASON_LENGTH).trim().min(1),
  })).max(MAX_SUGGESTIONS),
});
const jsonSchema = z.toJSONSchema(replySchema, { target: 'draft-7', override: ({ jsonSchema }) => {
  for (const field of ['minimum', 'maximum', 'exclusiveMinimum', 'minLength', 'maxLength', 'maxItems']) delete jsonSchema[field];
} });
const outputSchema = JSON.stringify(jsonSchema);
const PREVIEW_LIFETIME_MS = 10 * 60_000;

export type ConnectionPreviewRequest = z.infer<typeof connectionSchemas['connections:preview']>;
export type ConnectionRunRequest = z.infer<typeof connectionSchemas['connections:run']>;
export type ConnectionSuggestion = z.infer<typeof replySchema>['suggestions'][number];

export interface ConnectionProvenance {
  provider: ProviderId;
  model: string | null;
  modelSource: Exclude<ReturnType<typeof selectModel>['modelSource'], 'demo'>;
}

export interface ConnectionPreview extends ConnectionProvenance {
  token: string;
  prompt: string;
  bytes: number;
  outputSchema: string;
  files: string[];
}

export interface ConnectionResult {
  provenance: ConnectionProvenance;
  suggestions: ConnectionSuggestion[];
}

interface PendingPreview {
  conceptId: number;
  preview: Omit<ConnectionPreview, 'files'>;
  expiresAt: number;
}

interface ConnectionRunner {
  run(request: RunRequest<z.infer<typeof replySchema>>): Promise<RunResult<unknown>>;
}

function validateReply(value: unknown, provider: ProviderId, anchor: number, candidates: ReadonlySet<number>): ConnectionSuggestion[] {
  assert.ok(!candidates.has(anchor), 'the anchor is excluded from its own candidate set');
  assert.ok(candidates.size > 0, 'only a nonempty candidate scope can be sent');
  const parsed = replySchema.safeParse(value);
  if (!parsed.success) throw invalidOutputError(provider, 'the connection suggestions have an unexpected format', parsed.error);
  const seen = new Set<number>();
  for (const { fromConceptId, toConceptId } of parsed.data.suggestions) {
    if (fromConceptId !== anchor || !candidates.has(toConceptId) || seen.has(toConceptId)) {
      throw invalidOutputError(provider, 'each connection must link the selected concept to a distinct candidate from the preview');
    }
    seen.add(toConceptId);
  }
  return parsed.data.suggestions;
}

export class ConnectionSession {
  private pending: PendingPreview | null = null;

  constructor(private readonly loadScope: (conceptId: number) => ConnectionScope | null,
    private readonly runner: ConnectionRunner) {}

  preview(input: ConnectionPreviewRequest): ConnectionPreview {
    const { conceptId, provider } = connectionSchemas['connections:preview'].parse(input);
    this.clearPreview();
    const { model, modelSource } = selectModel(provider);
    assert.ok(modelSource !== 'demo', 'connection requests use real providers');
    assert.equal(model === null, modelSource === 'default', 'an explicit model must have a matching source');
    const scope = this.loadScope(conceptId);
    if (!scope) throw new DomainError('INVALID_CONNECTION_CONCEPT', 'Choose a concept from your knowledge graph.');
    const { prompt, bytes, candidateIds } = prepareConnectionScope(conceptId, scope);
    if (!candidateIds.size) throw new DomainError('NO_CONNECTION_CANDIDATES', 'There are no other unlinked concepts to compare.');
    const preview = { provider, model, modelSource, prompt, bytes, outputSchema, token: randomUUID() };
    this.pending = { conceptId, preview, expiresAt: Date.now() + PREVIEW_LIFETIME_MS };
    return { ...preview, files: [] };
  }

  async run(input: ConnectionRunRequest, signal?: AbortSignal): Promise<ConnectionResult> {
    const { token } = connectionSchemas['connections:run'].parse(input);
    const pending = this.pending;
    const stale = () => new DomainError('STALE_CONNECTION_PREVIEW', 'Preview the connection request again before sending.');
    if (!pending || pending.preview.token !== token) throw stale();
    this.clearPreview();
    if (Date.now() >= pending.expiresAt) throw stale();
    const { provider, model, modelSource, prompt } = pending.preview;
    if (signal?.aborted) throw cancelledError(provider);
    const { conceptId } = pending;
    const scope = this.loadScope(conceptId);
    if (!scope) throw stale();
    const prepared = prepareConnectionScope(conceptId, scope);
    if (prepared.prompt !== prompt) throw stale();
    const result = await this.runner.run({ provider, model: model ?? undefined, prompt,
      cacheKey: `connections/${token}`, schema: replySchema, jsonSchema, maxRetries: 0, signal });
    if (signal?.aborted) throw cancelledError(provider);
    assert.equal(result.provider, provider, 'provider must match the approved request');
    assert.equal(result.model, model, 'model selection must match the approved request');
    return { provenance: { provider: result.provider, model: result.model, modelSource },
      suggestions: validateReply(result.value, provider, conceptId, prepared.candidateIds) };
  }

  clearPreview(): void {
    this.pending = null;
  }
}
