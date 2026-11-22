import assert from 'node:assert/strict';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { bundleConfigSchema, labConfigSchema, type LabConfig } from '../../shared/lab-config';
import { packSchema } from '../../shared/instruments';
import { CHECK_ANSWER_LIMIT, type CodeSpan, type DiagramEdge, type LessonBlock } from '../../shared/lesson-blocks';

const label = z.string().min(1).max(1024);
const text = z.string().min(1).max(16000);
const nonblank = (value: string) => value.trim().length > 0;
const richLabel = label.refine(nonblank);
const richText = text.refine(nonblank);
const steps = z.array(text).min(1).max(80);
const span = z.object({ line: z.int().positive(), start: z.int().nonnegative(), end: z.int().positive() });
const edge = z.strictObject({ from: z.int().nonnegative(), to: z.int().nonnegative(), label: richLabel.optional() });
const pack = label.regex(/^[a-z][a-z0-9-]*@[1-9][0-9]*$/);
const lessonVersion = z.literal('delve.lesson/1');
const checkType = z.literal('check');
const writtenKind = z.enum(['short-answer', 'prediction']);
const choiceKind = z.enum(['choice', 'prediction']);
const expectedChoice = z.int().nonnegative();
const expectedText = z.array(z.string().min(1).max(CHECK_ANSWER_LIMIT).refine(nonblank)).min(1).max(12);
const options = z.array(label).min(2).max(12);
const prose = z.object({ type: z.literal('prose'), heading: label, text });
const analogy = z.strictObject({ type: z.literal('analogy'), heading: richLabel, text: richText });
const callout = z.strictObject({ type: z.literal('callout'), heading: richLabel, text: richText });
const example = z.strictObject({
  type: z.literal('example'), heading: richLabel, setup: richText,
  steps: z.array(richText).min(1).max(80), takeaway: richText,
});
const trace = z.object({ type: z.literal('trace'), steps });
const table = z.strictObject({
  type: z.literal('comparison'), heading: richLabel,
  columns: z.array(richLabel).min(2).max(12),
  rows: z.array(z.array(richText).min(2).max(12)).min(1).max(80),
}).refine(({ columns, rows }) => new Set(columns).size === columns.length
  && rows.every(row => row.length === columns.length), 'Every row needs one cell per distinct column.');
const beforeAfter = z.strictObject({
  type: z.literal('comparison'), heading: richLabel, before: richText, after: richText,
});
const diagramFields = z.object({
  type: z.literal('diagram'), nodes: z.array(richLabel).min(1).max(40), edges: z.array(edge).max(120).optional(),
});
const diagram = diagramFields
  .refine(({ nodes, edges }) => !edges || edges.every(({ from, to }) => from < nodes.length && to < nodes.length),
    'Diagram edges must connect existing nodes.')
  .transform(normalizeDiagram);
const code = z.object({
  type: z.literal('code'), source: label, lines: z.array(z.string().max(4000)).min(1).max(200),
  span: span.optional(), spans: z.array(span).max(200).optional(),
}).refine(validSpans, 'Code spans must be within a line, non-overlapping, and supplied as span or spans.');
const environment = z.object({
  type: z.literal('environment'), fallback: text.optional(), runtime: z.literal('delve.env/1').optional(), pack: pack.optional(),
  config: z.unknown().optional(),
}).refine(({ runtime, pack }) => Boolean(runtime) === Boolean(pack), 'An environment reference needs both runtime and pack.')
  .transform(({ config, ...block }): { type: 'environment'; fallback?: string; runtime?: 'delve.env/1'; pack?: string; config?: LabConfig } => {
    const parsed = labConfigSchema.safeParse(config);
    if (parsed.success && (!block.pack || block.pack === parsed.data.pack)) {
      return { ...block, runtime: 'delve.env/1', pack: parsed.data.pack, config: parsed.data };
    }
    if (config === undefined) return block;
    return { type: 'environment', ...(block.fallback ? { fallback: block.fallback } : {}) };
  });
const choice = z.object({
  type: checkType, kind: choiceKind.optional(), prompt: text, options, expected: expectedChoice,
}).refine(b => b.expected < b.options.length && new Set(b.options).size === b.options.length,
  'The expected choice must index one of the distinct options.');
const written = z.object({
  type: checkType, kind: writtenKind, prompt: richText, options: z.never().optional(), expected: expectedText,
}).refine(b => new Set(b.expected.map(answer => answer.trim().toLowerCase())).size === b.expected.length,
  'Expected responses must be distinct.');

const normalizeOption = (option: string) => option.normalize('NFKC').toLowerCase()
  .replace(/\p{Default_Ignorable_Code_Point}/gu, '').trim().replace(/\s+/g, ' ');
const predictionFields = z.strictObject({
  type: checkType, kind: z.literal('prediction'), prompt: richText,
  options: z.array(richLabel).length(4), expected: z.int().min(0).max(3),
});
export const freshCheckSchema = predictionFields.refine(({ options }) => {
  const normalized = new Set(options.map(normalizeOption));
  return normalized.size === 4 && !normalized.has('');
}, 'The check needs four distinct, nonblank choices.');
const unknown = z.object({ type: z.literal('unknown'), name: label });

function normalizeDiagram({ type, nodes, edges }: z.infer<typeof diagramFields>) {
  const nodeIndices = new Map<string, number>();
  const remap = nodes.map(raw => {
    const name = raw.trim();
    const index = nodeIndices.get(name);
    if (index !== undefined) return index;
    const next = nodeIndices.size;
    nodeIndices.set(name, next);
    return next;
  });
  const names = [...nodeIndices.keys()];
  assert.ok(names.length > 0 && names.length <= nodes.length, 'diagram normalization preserves at least one node');
  if (edges === undefined && names.length === nodes.length) return { type, nodes: names };

  // Materialize legacy transitions before remapping repeated stops.
  const original: DiagramEdge[] = edges ?? nodes.slice(1).map((_, from) => ({ from, to: from + 1 }));
  const unique = new Map<string, DiagramEdge>();
  for (const edge of original) {
    const from = remap[edge.from];
    const to = remap[edge.to];
    assert.ok(from !== undefined && to !== undefined, 'diagram endpoints must map to normalized nodes');
    const label = edge.label?.trim();
    unique.set(JSON.stringify([from, to, label]), label === undefined ? { from, to } : { from, to, label });
  }
  return { type, nodes: names, edges: [...unique.values()] };
}

function validSpans(block: { lines: string[]; span?: CodeSpan; spans?: CodeSpan[] }): boolean {
  const { span, spans } = block;
  if (span && spans) return false;
  const sorted = spans?.toSorted((a, b) => a.line - b.line || a.start - b.start) ?? (span ? [span] : []);
  for (const [index, current] of sorted.entries()) {
    const line = block.lines[current.line - 1];
    if (line === undefined || current.end > line.length || current.start >= current.end) return false;
    const prev = sorted[index - 1];
    if (prev?.line === current.line && prev.end > current.start) return false;
    assert.ok(!prev || prev.line <= current.line, 'code spans must be processed in line order');
  }
  return true;
}

const schemas = {
  prose, analogy, callout, example, comparison: table.or(beforeAfter),
  diagram, trace, code, environment, check: choice.or(written), unknown,
};

const blockTag = z.object({ type: label });
const blockSchema = z.unknown().transform((raw, ctx) => {
  const tag = blockTag.safeParse(raw);
  if (!tag.success) {
    ctx.addIssue({ code: 'custom', path: ['type'], message: 'A lesson block needs a type.' });
    return z.NEVER;
  }
  const { type } = tag.data;
  if (!Object.hasOwn(schemas, type)) return { type: 'unknown' as const, name: type };
  const result = schemas[type as keyof typeof schemas].safeParse(raw);
  if (result.success) return result.data;
  for (const { path, message } of result.error.issues) ctx.addIssue({ code: 'custom', path, message });
  return z.NEVER;
});

export const documentSchema = z.object({
  schema: lessonVersion,
  source: label.optional(),
  blocks: z.array(blockSchema).min(1).max(80),
}).refine(doc => doc.blocks.filter(block => block.type === 'check').length <= 1, 'A lesson can include at most one check.');

export type Document = z.infer<typeof documentSchema>;

const generationBlock = z.union([
  prose.strict(), analogy, callout, example, table, trace.strict(),
  z.strictObject({
    ...diagramFields.shape,
    edges: z.array(edge.extend({ label: richLabel.nullable() })).max(120).nullable(),
  }),
  z.strictObject({ type: code.shape.type, source: code.shape.source, lines: code.shape.lines, spans: z.array(span.strict()).max(200) }),
  z.strictObject({ type: z.literal('environment'), fallback: richText, pack: pack.nullable(), config: z.union([
    packSchema,
    bundleConfigSchema.extend({ bundle: bundleConfigSchema.shape.bundle.omit({ sha256: true }) }),
  ]).nullable().optional() }),
  freshCheckSchema,
]);

const generationWire = z.strictObject({
  schema: lessonVersion,
  source: label.nullable(),
  blocks: z.array(generationBlock).min(1).max(80),
});

type GeneratedBlock = z.infer<typeof generationBlock>;

function adaptGeneratedBlock(block: GeneratedBlock) {
  if (block.type === 'environment') {
    const { config, pack: packName, ...rest } = block;
    const normalized = config?.pack === 'bundle@1'
      ? { ...config, bundle: { ...config.bundle, sha256: createHash('sha256').update(config.bundle.source, 'utf8').digest('hex') } }
      : config;
    return { ...rest, ...(packName === null ? {} : { pack: packName, runtime: 'delve.env/1' as const }),
      ...(normalized ? { config: normalized } : {}) };
  }
  if (block.type !== 'diagram') return block;
  const { edges, ...diagram } = block;
  if (edges === null) return diagram;
  return { ...diagram, edges: edges.map(({ label, ...edge }) => label === null ? edge : { ...edge, label }) };
}

const futureBlock = blockTag.refine(tag => !Object.hasOwn(schemas, tag.type))
  .transform(tag => ({ type: 'unknown' as const, name: tag.type }));

export const documentGenerationSchema = generationWire.extend({
  blocks: z.array(generationBlock.or(futureBlock)).min(1).max(80),
}).transform(({ source, ...document }): z.input<typeof documentSchema> => ({
  ...document,
  ...(source === null ? {} : { source }),
  blocks: document.blocks.map(block => block.type === 'unknown' ? block : adaptGeneratedBlock(block)),
})).pipe(documentSchema);

// Keep provider constraints structural; the parser also validates bounds and cross-field invariants.
export const documentJsonSchema = z.toJSONSchema(generationWire, {
  target: 'draft-7',
  io: 'input',
  override: ({ jsonSchema }) => {
    if (jsonSchema.type === 'object' && jsonSchema.properties) jsonSchema.required = Object.keys(jsonSchema.properties);
    if (jsonSchema.oneOf) { jsonSchema.anyOf = jsonSchema.oneOf; delete jsonSchema.oneOf; }
    delete jsonSchema.minLength;
    delete jsonSchema.maxLength;
    delete jsonSchema.minItems;
    delete jsonSchema.maxItems;
    delete jsonSchema.minimum;
    delete jsonSchema.maximum;
    delete jsonSchema.pattern;
    if (typeof jsonSchema.const === 'string') {
      jsonSchema.enum = [jsonSchema.const];
      delete jsonSchema.const;
    }
  },
});

delete documentJsonSchema.$schema;

export function publicBlocks(doc: Document): LessonBlock[] {
  return doc.blocks.map(block => {
    if (block.type === 'environment') {
      const { config, ...metadata } = block;
      if (!config) return metadata;
      if (config.pack === 'bundle@1') return { ...metadata, title: config.parameters.title, bundleHash: config.bundle.sha256 };
      return { ...metadata, config };
    }
    if (block.type !== 'check') return block;
    const { type, prompt, kind, options } = block;
    assert.ok(kind !== undefined || options !== undefined, 'legacy checks always have options');
    if (options !== undefined) return kind ? { type, kind, prompt, options } : { type, prompt, options };
    assert.ok(kind === 'short-answer' || kind === 'prediction', 'written checks have a written kind');
    return { type, kind, prompt };
  });
}
