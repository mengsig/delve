import type { Workspace } from '../../shared/domain';

export interface ShortcutKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** True for Ctrl+K, or Cmd+K on macOS: the shortcut that opens the workspace switcher. */
export function isSwitcherShortcut(event: ShortcutKey, isMac: boolean): boolean {
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
}

/** Workspaces whose name or source contains every word of `query`, in their listed order. */
export function filterWorkspaces(workspaces: Workspace[], query: string): Workspace[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return workspaces;
  return workspaces.filter((workspace) => {
    const haystack = `${workspace.name} ${workspace.source}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Moves a highlighted index by `step`, wrapping around a list of `count` options. */
export function moveIndex(index: number, step: number, count: number): number {
  if (!Number.isInteger(index) || !Number.isInteger(step) || !Number.isInteger(count)) throw new Error('moveIndex takes integers');
  if (count <= 0) return -1;
  if (index >= count) throw new Error(`highlight ${index} is outside ${count} options`);
  const from = index < 0 ? (step > 0 ? -1 : 0) : index;
  return (((from + step) % count) + count) % count;
}
