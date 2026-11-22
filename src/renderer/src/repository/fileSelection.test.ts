import { expect, it } from 'vitest';
import { defaultFiles, MAX_BYTES, MAX_FILE_BYTES, MAX_FILES, selectVisibleFiles } from './fileSelection';

it('keeps a README and ordinary source even when the repository has many docs', () => {
  const files = [
    ...Array.from({ length: 20 }, (_, index) => ({ path: `docs/how-to-${index}.md`, bytes: 1 })),
    { path: 'lib/queue.ts', bytes: 1 }, { path: 'lib/worker.ts', bytes: 1 },
    { path: 'README.md', bytes: 1 },
  ];
  const selected = [...defaultFiles(files)];
  expect(selected).toEqual(['README.md', 'docs/how-to-0.md', 'docs/how-to-1.md', 'docs/how-to-10.md',
    'lib/queue.ts', 'lib/worker.ts']);
  expect([...defaultFiles(files.reverse())]).toEqual(selected);
});

it('takes up to sixteen ordinary files from a source-only repository', () => {
  const files = Array.from({ length: 30 }, (_, index) => ({ path: `src/source-${index}.ts`, bytes: 1 }));
  const selected = defaultFiles(files);
  expect(selected.size).toBe(16);
  expect(selected.has('src/source-0.ts')).toBe(true);
});

it('skips oversized and over-budget defaults while taking smaller files that still fit', () => {
  const files = [
    { path: 'README.md', bytes: MAX_FILE_BYTES + 1 },
    ...Array.from({ length: 9 }, (_, index) => ({
      path: `lib/${index}.ts`, bytes: index === 0 ? MAX_FILE_BYTES - 1 : MAX_FILE_BYTES,
    })),
    { path: 'lib/z.ts', bytes: 1 },
  ];
  const selected = defaultFiles(files);
  expect(selected.has('README.md')).toBe(false);
  expect(selected.has('lib/8.ts')).toBe(false);
  expect(selected.has('lib/z.ts')).toBe(true);
  expect(files.filter(file => selected.has(file.path)).reduce((bytes, file) => bytes + file.bytes, 0)).toBe(MAX_BYTES);
});

it('adds only visible files, counting hidden selections against the byte budget', () => {
  const paths = new Set(['hidden.ts', 'visible/checked.ts']);
  const visible = [
    { path: 'visible/checked.ts', bytes: 1 },
    { path: 'visible/over-budget.ts', bytes: 2 },
    { path: 'visible/oversized.ts', bytes: MAX_FILE_BYTES + 1 },
    { path: 'visible/fits.ts', bytes: 1 },
  ];
  const result = selectVisibleFiles(visible, paths, MAX_BYTES - 1);
  expect([...result.selected]).toEqual(['hidden.ts', 'visible/checked.ts', 'visible/fits.ts']);
  expect(result).toMatchObject({ oversized: 1, overBudget: 1 });
  expect([...paths]).toEqual(['hidden.ts', 'visible/checked.ts']);
});

it('stops adding files when hidden selections fill the count budget', () => {
  const paths = new Set(Array.from({ length: MAX_FILES - 1 }, (_, index) => `hidden-${index}.ts`));
  const result = selectVisibleFiles([{ path: 'visible-a.ts', bytes: 0 }, { path: 'visible-b.ts', bytes: 0 }], paths, 0);
  expect(result.selected.size).toBe(MAX_FILES);
  expect(result.selected.has('visible-a.ts')).toBe(true);
  expect(result.selected.has('visible-b.ts')).toBe(false);
  expect(result.overBudget).toBe(1);
});
