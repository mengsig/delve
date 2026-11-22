import type { RepositoryFile } from '../../../shared/repository';

export const MAX_FILES = 128;
export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_BYTES = 1024 * 1024;
const DEFAULT_FILES = 16;
const DEFAULT_CONTEXT_FILES = 4;

function priority(path: string) {
  if (/^readme(?:\.|$)/i.test(path)) return 0;
  if (/^(?:docs\/|package\.json$|Cargo\.toml$|pyproject\.toml$|go\.mod$)|\.(?:md|mdx|rst|adoc)$/i.test(path)) return 1;
  if (/(?:^|\/)(?:main|index|app)\.[a-z0-9]+$/i.test(path)) return 2;
  return 3;
}

export function fitsFileSlice(file: RepositoryFile, count: number, bytes: number): boolean {
  return file.bytes <= MAX_FILE_BYTES && count < MAX_FILES && bytes + file.bytes <= MAX_BYTES;
}

export function defaultFiles(files: RepositoryFile[]): Set<string> {
  const ranked = files.filter(file => fitsFileSlice(file, 0, 0)).map(file => ({ file, rank: priority(file.path) }))
    .sort((a, b) => a.rank - b.rank || (a.file.path < b.file.path ? -1 : Number(a.file.path > b.file.path)));
  const contextLimit = ranked.some(({ rank }) => rank >= 2) ? DEFAULT_CONTEXT_FILES : DEFAULT_FILES;
  const selected = new Set<string>();
  let bytes = 0;
  for (const { file, rank } of ranked) {
    if (selected.size === DEFAULT_FILES) break;
    if (rank < 2 && selected.size >= contextLimit) continue;
    if (!fitsFileSlice(file, selected.size, bytes)) continue;
    selected.add(file.path);
    bytes += file.bytes;
  }
  return selected;
}

export function selectVisibleFiles(visible: RepositoryFile[], paths: Set<string>, selectedBytes: number) {
  const selected = new Set(paths);
  let bytes = selectedBytes;
  let oversized = 0;
  let overBudget = 0;
  for (const file of visible) {
    if (selected.has(file.path)) continue;
    if (file.bytes > MAX_FILE_BYTES) {
      oversized++;
    } else if (!fitsFileSlice(file, selected.size, bytes)) {
      overBudget++;
    } else {
      selected.add(file.path);
      bytes += file.bytes;
    }
  }
  return { selected, oversized, overBudget };
}

export function retainFiles(files: RepositoryFile[], paths: Set<string>): Set<string> {
  const selected = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (!paths.has(file.path) || !fitsFileSlice(file, selected.size, bytes)) continue;
    selected.add(file.path);
    bytes += file.bytes;
  }
  return selected;
}
