import { z } from 'zod';
import { DEPTHS, PROVIDER_IDS } from '../../shared/domain';

export const commitRef = z.string().regex(/^[0-9a-f]{7,64}$/i);
export const prRef = z.string().regex(/^[1-9][0-9]{0,9}$/);
const workspace = z.strictObject({ workspaceId: z.uuid() });
const scope = workspace.extend({ provider: z.enum(PROVIDER_IDS), depth: z.enum(DEPTHS) });
const commit = z.strictObject({ kind: z.literal('commit'), ref: commitRef });
const pr = z.strictObject({ kind: z.literal('pr'), ref: prRef });
const baseline = z.strictObject({ kind: z.literal('baseline'), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(128) });
export const repoSchemas = {
  'repo:files': workspace,
  'repo:changes': workspace,
  'repo:preview': scope.extend({ selection: z.discriminatedUnion('kind', [baseline, commit, pr]) }),
  'repo:saved': z.discriminatedUnion('kind', [scope.extend(commit.shape), scope.extend(pr.shape)]),
  'repo:generate': z.strictObject({ token: z.uuid(), requestId: z.uuid() }),
  'repo:cancel': z.strictObject({ requestId: z.uuid() }),
  'learn:pending': z.null(),
  'learn:resolve': z.strictObject({ id: z.uuid(), accept: z.boolean() }),
};

const text = z.string().trim().min(1).max(4000);
const key = z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,149}$/).refine(s => !s.startsWith('ws/') && !s.startsWith('change/'));
const concept = z.strictObject({ key, title: z.string().trim().min(1).max(180), summary: text, portable: z.boolean() });
const graph = z.strictObject({
  concepts: z.array(concept).min(1).max(60),
  edges: z.array(z.strictObject({ concept: key, prerequisite: key })).max(160),
  recommendation: z.strictObject({ key, reason: text }),
});
export const baselineReply = graph.extend({ schema: z.literal('delve.map/1') });
export const changeReply = graph.extend({ schema: z.literal('delve.change/1'), concepts: z.array(concept).max(60),
  recommendation: z.strictObject({ key: key.nullable(), reason: text }), summary: text, what: text, why: text, before: text, after: text,
  mechanics: text.nullable(), boundary: text.nullable(), trace: z.array(z.string().trim().min(1).max(160)).max(8),
  excerpt: z.array(z.string().max(2000)).max(16) });
export type GraphProposal = z.infer<typeof baselineReply> | z.infer<typeof changeReply>;
export type ChangeReply = z.infer<typeof changeReply>;
