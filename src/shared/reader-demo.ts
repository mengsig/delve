import type { LessonBlock } from './reader';

export const demoBrief = {
  base: '49bf380',
  head: '8c2a1d7',
  sections: [
    ['What changed', 'Old workers can no longer replace a newer result.'],
    ['Why it matters', 'An expired worker can finish late. Its output used to look valid even after another worker had taken over.'],
    ['How it works', 'Dispatch increments a generation on reassignment. The result writer accepts only the generation currently attached to the task.'],
    ['Protocol edge', 'Generation 7 arrives after generation 8 was issued. The guarded write affects zero rows. The writer reports StaleLease instead of retrying the old payload.'],
  ],
};

export const demoGuardedWrite: Extract<LessonBlock, { type: 'code' }> = {
  type: 'code', source: 'result_store.rs:42 · 8c2a1d7 (fixture)',
  lines: ['UPDATE tasks SET result = :value', 'WHERE id = :task AND generation = :claim;'],
  span: { line: 2, start: 21, end: 40 },
};
