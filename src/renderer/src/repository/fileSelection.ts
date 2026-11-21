import type { RepositoryFile } from '../../../shared/repository';

export const MAX_FILES = 128;
export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_BYTES = 1024 * 1024;

function priority(path: string) {
  if (/^readme(?:\.|$)/i.test(path)) return 0;
  if (/^(?:docs\/|package\.json$|Cargo\.toml$|pyproject\.toml$|go\.mod$)/i.test(path)) return 1;
  if (/(?:^|\/)(?:main|index|app)\.[a-z0-9]+$/i.test(path)) return 2;
  return 3;
}

export function fitsFileSlice(file: RepositoryFile, count: number, bytes: number): boolean {
  return file.bytes <= MAX_FILE_BYTES && count < MAX_FILES && bytes + file.bytes <= MAX_BYTES;
}

export function defaultFiles(files: RepositoryFile[]): Set<string> {
  const ranked = files.map(file => ({ file, rank: priority(file.path) }))
    .sort((a, b) => a.rank - b.rank || a.file.path.localeCompare(b.file.path));
  const selected = new Set<string>();
  let bytes = 0;
  for (const { file, rank } of ranked) {
    if (selected.size === 16 || (rank === 3 && selected.size > 0)) break;
    if (!fitsFileSlice(file, selected.size, bytes)) continue;
    selected.add(file.path);
    bytes += file.bytes;
  }
  return selected;
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
