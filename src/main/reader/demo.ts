import assert from 'node:assert/strict';
import { demoGuardedWrite } from '../../shared/reader-demo';
import type { Depth } from '../../shared/domain';
import type { Db } from '../db/connection';
import { lessonCacheKey, saveLesson, TUTOR_GENERATION } from '../db/lessons';
import { documentSchema, freshCheckSchema, type Document } from './document';
import material from './demo-material.json';

export interface LessonContext {
  workspaceId: string;
  conceptId: number;
  key: string;
  title: string;
  summary: string;
  depth: Depth;
  portable: boolean;
  topic: boolean;
  demo: boolean;
  snapshotId: number | null;
  snapshot: string | null;
}

const examples: Record<string, string> = {
  lease: 'After three ticks, B holds generation 8. A offers generation 7. Compare before committing.',
  exposure: 'At fixed aperture, use a faster shutter for motion. Raise ISO to compensate displayed brightness.',
};

export function demoMaterial(key: string) {
  const id = key.split(':').at(-1);
  assert.ok(id && Object.hasOwn(material, id), 'expected a concept from the demo provider');
  return { id, item: material[id as keyof typeof material] };
}

export function demoReply(context: LessonContext, question: string): string {
  assert.ok(context.demo, 'sample replies belong to demo workspaces');
  const { item, id } = demoMaterial(context.key);
  if (/\b(example|show|scenario)\b/i.test(question)) return examples[id] ?? item.detail;
  if (/\b(why|mean|idea|what)\b/i.test(question)) return context.summary + ' ' + item.mechanics;
  if (/\b(how|explain|detail|work|works)\b/i.test(question)) return item.mechanics + ' ' + item.detail;
  return `This offline demo has a short guide to ${context.title}. Ask how it works, why it matters, or for a worked example.`;
}

export function demoDocument(context: LessonContext): Document {
  assert.ok(context.demo, 'demo lessons require a demo workspace');
  const { id, item } = demoMaterial(context.key);
  const { depth, topic } = context;
  const source = context.snapshot ?? 'Field study · 01';
  const idea = id === 'lease'
    ? 'A lease gives one worker the right to finish a task until a deadline. If that worker disappears, another can take over. The result writer needs a way to tell their claims apart.'
    : id === 'exposure' ? 'Shutter time controls how far the rider moves during the exposure. ISO lets you change displayed brightness after choosing a time that freezes the motion.'
      : context.summary;
  const blocks: unknown[] = [{ type: 'prose', heading: 'The idea', text: idea }];
  if (examples[id]) blocks.push({ type: 'environment', runtime: 'delve.env/1', pack: id === 'lease' ? 'lease-handoff@1' : 'camera-exposure@1', fallback: examples[id] });
  if (depth !== 'high') blocks.push({ type: 'prose', heading: topic ? 'In the field' : 'Inside the system', text: item.mechanics });
  if (id === 'lease') blocks.push({ type: 'diagram', nodes: ['Queue', 'Lease grant', 'Result writer'] });
  if (depth === 'low') blocks.push({ type: 'prose', heading: topic ? 'At the controls' : 'At the boundary', text: item.detail });
  if (id === 'lease' && depth === 'low') blocks.push(demoGuardedWrite);
  if (id === 'lease') blocks.push({ type: 'analogy', heading: 'A claim ticket that expires',
    text: 'Think of a numbered claim ticket. The desk issues a new number when your time runs out. An old ticket still names the right job, but it cannot collect the result.' });
  blocks.push(freshCheckSchema.parse(item.checks[depth]));
  return documentSchema.parse({ schema: 'delve.lesson/1', blocks, source });
}

export function createDemoLesson(db: Db, context: LessonContext): void {
  const { workspaceId, conceptId, depth } = context;
  const doc = demoDocument(context);
  const parts = { schemaVersion: doc.schema, generation: TUTOR_GENERATION, depth, provider: 'demo', model: 'field-tutor-v1',
    sourceRef: workspaceId + '/' + (context.snapshot ?? 'concept'), conceptKey: context.key };
  const cacheKey = lessonCacheKey(parts);
  saveLesson(db, { ...parts, cacheKey, workspaceId, conceptId, snapshotId: context.snapshotId ?? undefined, body: doc });
}
