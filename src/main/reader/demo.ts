import assert from 'node:assert/strict';
import { demoGuardedWrite } from '../../shared/reader-demo';
import type { Depth } from '../../shared/domain';
import type { Db } from '../db/connection';
import { lessonCacheKey, saveLesson } from '../db/lessons';
import { documentSchema, type Document } from './document';
import material from './demo-material.json';

export interface LessonContext {
  workspaceId: string;
  conceptId: number;
  key: string;
  title: string;
  summary: string;
  depth: Depth;
  topic: boolean;
  demo: boolean;
  snapshotId: number | null;
  snapshot: string | null;
}

const examples: Record<string, string> = {
  lease: 'After three ticks, B holds generation 8. A offers generation 7. Compare before committing.',
  exposure: 'At fixed aperture, use a faster shutter for motion. Raise ISO to compensate displayed brightness.',
};

function demoMaterial(key: string) {
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

export function createDemoLesson(db: Db, context: LessonContext): void {
  assert.ok(context.demo, 'demo lessons require a demo workspace');
  const { id, item } = demoMaterial(context.key);
  const { depth, topic, workspaceId, conceptId } = context;
  const source = context.snapshot ?? 'Field study · 01';
  const blocks: unknown[] = [{ type: 'prose', heading: 'The idea', text: context.summary }];
  if (examples[id]) blocks.push({ type: 'environment', fallback: examples[id] });
  if (depth !== 'high') blocks.push({ type: 'prose', heading: topic ? 'In the field' : 'Inside the system', text: item.mechanics });
  if (id === 'lease') blocks.push({ type: 'diagram', nodes: ['Queue', 'Lease grant', 'Result writer'] });
  if (depth === 'low') blocks.push({ type: 'prose', heading: topic ? 'At the controls' : 'At the boundary', text: item.detail });
  if (id === 'lease' && depth === 'low') blocks.push(demoGuardedWrite);
  blocks.push(item.checks[depth]);
  const doc: Document = documentSchema.parse({ schema: 'delve.lesson/1', blocks, source });
  const parts = { schemaVersion: doc.schema, depth, provider: 'demo', model: 'proposal-v1', sourceRef: source, conceptKey: context.key };
  const cacheKey = lessonCacheKey({ ...parts, sourceRef: workspaceId + '/' + source });
  saveLesson(db, { ...parts, cacheKey, workspaceId, conceptId, snapshotId: context.snapshotId ?? undefined, body: doc });
}
