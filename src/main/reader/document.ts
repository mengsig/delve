import { z } from 'zod';
import type { CodeSpan, LessonBlock } from '../../shared/reader';

const label = z.string().min(1).max(1024);
const text = z.string().min(1).max(16000);
const lines = z.array(z.string().max(4000)).min(1).max(200);
const span = z.object({ line: z.int().positive(), start: z.int().nonnegative(), end: z.int().positive() });

function validSpan(block: { lines: string[]; span?: CodeSpan }): boolean {
  if (!block.span) return true;
  const { line, start, end } = block.span;
  const source = block.lines[line - 1];
  return source !== undefined && start < end && end <= source.length;
}

const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prose'), heading: label, text }),
  z.object({ type: z.literal('diagram'), nodes: z.array(label).min(1).max(40) }),
  z.object({ type: z.literal('trace'), steps: z.array(text).min(1).max(80) }),
  z.object({ type: z.literal('code'), source: label, lines, span: span.optional() }).refine(validSpan),
  z.object({ type: z.literal('environment'), fallback: text.optional() }),
  z.object({
    type: z.literal('check'), prompt: text, options: z.array(label).min(2).max(12), expected: z.int().nonnegative(),
  }).refine(b => b.expected < b.options.length && new Set(b.options).size === b.options.length),
  z.object({ type: z.literal('unknown'), name: label }),
]);

const supported = new Set(blockSchema.options.map(option => option.shape.type.value));
const block = z.preprocess(raw => {
  const tag = z.object({ type: label }).safeParse(raw);
  if (tag.success && !supported.has(tag.data.type as LessonBlock['type'])) {
    return { type: 'unknown', name: tag.data.type };
  }
  return raw;
}, blockSchema);

export const documentSchema = z.object({
  schema: z.literal('delve.lesson/1'),
  source: label.optional(),
  blocks: z.array(block).min(1).max(80),
}).refine(doc => doc.blocks.filter(block => block.type === 'check').length <= 1);

export type Document = z.infer<typeof documentSchema>;

export function publicBlocks(doc: Document): LessonBlock[] {
  return doc.blocks.map(block => block.type === 'check'
    ? { type: 'check', prompt: block.prompt, options: block.options }
    : block);
}
