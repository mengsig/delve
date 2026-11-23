import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { documentGenerationSchema, documentJsonSchema, documentSchema, publicBlocks } from './document';

const prose = { type: 'prose', heading: 'Transit', text: 'The bus stops here.' };
const choice = { type: 'check', prompt: 'Which route?', options: ['Express', 'Local'], expected: 1 };
const code = { type: 'code', source: 'route.ts:5', lines: ['const route = "local";', 'stop(route);'] };
const nodes = ['Depot', 'Station', 'Garage'];
const table = {
  type: 'comparison', heading: 'Routes', columns: ['Route', 'Stops'], rows: [['Express', '2'], ['Local', '6']],
};
const written = {
  type: 'check', kind: 'short-answer', prompt: 'Why take the local route?', expected: ['It stops at the station.'],
};

function lesson(...blocks: unknown[]) {
  return { schema: 'delve.lesson/1', blocks };
}

describe('lesson documents', () => {
  it('keeps legacy blocks and renders unknown blocks as a name', () => {
    const legacy = lesson(
      prose, { type: 'diagram', nodes }, { type: 'trace', steps: ['Depart', 'Arrive'] },
      { ...code, span: { line: 1, start: 6, end: 11 } }, { type: 'environment' }, choice,
    );
    expect(documentSchema.parse(legacy)).toStrictEqual(legacy);
    const unknown = documentSchema.parse(lesson({ type: 'future', markup: '<iframe></iframe>' }));
    expect(publicBlocks(unknown)).toStrictEqual([{ type: 'unknown', name: 'future' }]);
  });

  it('keeps structured examples, comparisons, edges, and multiple spans', () => {
    const rich = lesson(
      { type: 'analogy', heading: 'A relay', text: 'Workers hand off the task.' },
      { type: 'callout', heading: 'Night service', text: 'Check the last departure.' },
      { type: 'example', heading: 'Boarding', setup: 'Two buses arrive.', steps: ['Read the sign'], takeaway: 'Pick local.' },
      table, { type: 'comparison', heading: 'Updates', before: 'Hourly', after: 'Every 20 minutes' },
      { type: 'diagram', nodes, edges: [{ from: 0, to: 1, label: 'boards' }, { from: 1, to: 2 }] },
      { ...code, spans: [{ line: 2, start: 0, end: 4 }, { line: 1, start: 6, end: 11 }, { line: 1, start: 14, end: 21 }] },
      { type: 'environment', runtime: 'delve.env/1', pack: 'route-review@1', fallback: 'Compare stops before boarding.' },
    );
    expect(publicBlocks(documentSchema.parse(rich))).toStrictEqual(rich.blocks);
  });

  it.each([
    { ...table, rows: [['Express', '2', 'late']] },
    { ...table, columns: ['Route', 'Route'] },
    { type: 'analogy', heading: ' ', text: 'Analogy body' },
    { type: 'example', heading: 'Example', setup: 'Setup', steps: [], takeaway: 'Result' },
    { type: 'diagram', nodes, edges: [{ from: 0, to: 3 }] },
    { type: 'diagram', nodes, edges: [{ from: -1, to: 1 }] },
    { type: 'diagram', nodes, edges: [{ from: 0, to: 1.5 }] },
    { type: 'diagram', nodes, edges: [{ from: 0, to: 1, label: ' ' }] },
    { type: 'diagram', nodes: [] },
    { type: 'diagram', nodes: ['Depot', '\t'] },
    { ...code, span: { line: 0, start: 0, end: 2 } },
    { ...code, spans: [{ line: 1, start: 0, end: 100 }] },
    { ...code, spans: [{ line: 1, start: 0, end: 2 }, { line: 1, start: 1, end: 3 }] },
    { ...code, spans: [], span: { line: 1, start: 0, end: 2 } },
    { type: 'environment', runtime: 'delve.env/1', pack: '../route@1' },
    { ...choice, expected: 2 },
    { ...choice, options: ['Local', 'Local'] },
    { ...written, expected: ['\t'] },
    { ...written, expected: ['Local service', ' local service '] },
    { ...written, kind: 'prediction', options: choice.options },
  ])('rejects a malformed $type block', block => {
    expect(documentSchema.safeParse(lesson(block)).success).toBe(false);
  });

  it('enforces one optional check across variants and strips its answer key', () => {
    expect(documentSchema.safeParse(lesson(choice, written)).success).toBe(false);
    for (const check of [choice, { ...choice, kind: 'choice' }, { ...choice, kind: 'prediction' },
      written, { ...written, kind: 'prediction' }]) {
      const publicCheck = publicBlocks(documentSchema.parse(lesson(check)));
      expect(publicCheck).toStrictEqual([Object.fromEntries(Object.entries(check).filter(([key]) => key !== 'expected'))]);
    }
  });
});

describe('diagram documents', () => {
  it('remaps Task, Agent, and Run edges before deduplicating them', () => {
    const graph = {
      type: 'diagram', nodes: ['Task', ' Agent ', 'Run', 'Agent', 'Task'],
      edges: [
        { from: 2, to: 1, label: 'groups' }, { from: 2, to: 3, label: ' groups ' },
        { from: 1, to: 0, label: 'works on' }, { from: 3, to: 4, label: 'works on' },
      ],
    };
    const parsed = documentSchema.parse(lesson(graph));
    expect(publicBlocks(parsed)).toStrictEqual([{
      type: 'diagram', nodes: ['Task', 'Agent', 'Run'],
      edges: [{ from: 2, to: 1, label: 'groups' }, { from: 1, to: 0, label: 'works on' }],
    }]);
    expect(documentSchema.parse(parsed)).toStrictEqual(parsed);
    expect(documentGenerationSchema.parse({ ...lesson(graph), source: null })).toStrictEqual(parsed);
  });

  it('keeps distinct labels, directions, and self-loops when removing duplicate edges', () => {
    const edges = [
      { from: 0, to: 1 }, { from: 0, to: 1, label: 'retries' },
      { from: 1, to: 0 }, { from: 1, to: 1, label: 'waits' },
    ];
    const block = { type: 'diagram', nodes, edges };
    const repeated = [...edges, ...edges];
    expect(documentSchema.parse(lesson({ ...block, edges: repeated }))).toStrictEqual(lesson(block));
    const generated = { ...block, edges: repeated.map(edge => ({ ...edge, label: edge.label ?? null })) };
    expect(documentGenerationSchema.parse({ ...lesson(generated), source: null })).toStrictEqual(lesson(block));
  });

  it('preserves transitions through repeated legacy nodes and honors explicit empty edges', () => {
    const legacy = { type: 'diagram', nodes: ['Depot', 'Station', 'Depot', 'Garage'] };
    expect(documentSchema.parse(lesson(legacy))).toStrictEqual(lesson({
      type: 'diagram', nodes, edges: [{ from: 0, to: 1 }, { from: 1, to: 0 }, { from: 0, to: 2 }],
    }));
    expect(documentSchema.parse(lesson({ ...legacy, edges: [] }))).toStrictEqual(lesson({
      type: 'diagram', nodes, edges: [],
    }));
  });
});

describe('provider lesson documents', () => {
  it('normalizes a generated bundle and retains a safe fallback for malformed saved config', () => {
    const source = 'function step(initial, action) { return {text: initial, controls: [], marks: []}; }';
    const config = { pack: 'bundle@1', bundle: { apiVersion: 'delve.view/1', entry: 'step', source },
      parameters: { title: 'Practice', initial: 'Try it' } };
    const wire = { ...lesson({ type: 'environment', fallback: 'Practice by hand.', pack: null, config }), source: null };
    const generated = documentGenerationSchema.parse(wire);
    expect(generated.blocks[0]).toMatchObject({ config: { bundle: { sha256: createHash('sha256').update(source).digest('hex') } } });
    const published = publicBlocks(generated);
    expect(published[0]).toMatchObject({ title: 'Practice', pack: 'bundle@1', runtime: 'delve.env/1' });
    expect(JSON.stringify(published)).not.toContain(source);
    const malformed = documentSchema.parse(lesson({ type: 'environment', fallback: 'Practice by hand.', config: { pack: 'bogus' } }));
    expect(malformed.blocks[0]).toEqual({ type: 'environment', fallback: 'Practice by hand.' });
  });

  it('adapts required nullable fields and validates the resulting lesson', () => {
    const prediction = { type: 'check', kind: 'prediction', prompt: 'Which turn gets the rider in frame?',
      options: ['First', 'Second', 'Third', 'Fourth'], expected: 1 };
    const wire = { ...lesson(
      prose, table, { type: 'diagram', nodes, edges: null },
      { type: 'diagram', nodes, edges: [{ from: 0, to: 1, label: null }] },
      { ...code, spans: [] }, { type: 'environment', pack: null, fallback: 'Review the map.' }, prediction,
    ), source: null };
    expect(documentGenerationSchema.parse(wire)).toStrictEqual(lesson(
      prose, table, { type: 'diagram', nodes }, { type: 'diagram', nodes, edges: [{ from: 0, to: 1 }] },
      { ...code, spans: [] }, { type: 'environment', fallback: 'Review the map.' }, prediction,
    ));
    expect(documentGenerationSchema.safeParse({ ...wire, blocks: [{ ...table, rows: [['Local']] }] }).success).toBe(false);
    expect(documentGenerationSchema.safeParse({ ...wire, blocks: [{ ...prose, extra: 'ignored?' }] }).success).toBe(false);
    expect(documentGenerationSchema.parse({ ...wire, blocks: [{ type: 'future', markup: '<script>' }] }).blocks)
      .toEqual([{ type: 'unknown', name: 'future' }]);
    expect(documentGenerationSchema.safeParse(lesson(prose)).success).toBe(false);
    expect(documentGenerationSchema.safeParse({
      ...wire, blocks: [{ type: 'diagram', nodes, edges: [{ from: 3, to: 0, label: null }] }],
    }).success).toBe(false);
  });

  it('uses a closed required object at every level and a finite union of blocks', () => {
    expect(documentJsonSchema.type).toBe('object');
    expect(documentJsonSchema).toHaveProperty('properties.blocks.items.anyOf');
    const json = JSON.stringify(documentJsonSchema, (_key, schema: unknown) => {
      if (schema && typeof schema === 'object' && 'type' in schema && schema.type === 'object') {
        expect(schema).toHaveProperty('additionalProperties', false);
        expect(schema).toHaveProperty('required', Object.keys('properties' in schema ? schema.properties as object : {}));
      }
      return schema;
    });
    expect(json).not.toMatch(/"(?:\$schema|oneOf|const|pattern|minItems|maxItems|minimum|maximum|minLength|maxLength)"/);
  });

  it.each([
    ['Either claim', 'Either claim '],
    ['CLAIM 7', 'claim 7'],
    ['Ⅳ', 'IV'],
    ['Next worker', 'Next\u200b worker'],
    ['This worker', '   '],
  ])('rejects ambiguous fresh options %j and %j while preserving historical wording', (first, second) => {
    const check = { type: 'check', kind: 'prediction', prompt: 'Which worker can finish?', options: [first, second, 'A', 'B'], expected: 1 };
    const saved = lesson(check);
    expect(documentSchema.parse(saved)).toEqual(saved);
    expect(documentGenerationSchema.safeParse({ ...saved, source: null }).success).toBe(false);
  });
});
