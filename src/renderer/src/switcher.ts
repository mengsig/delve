import type { Command } from './commands';

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

export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return commands;
  return commands.filter(command => {
    const text = [command.label, command.detail, command.search].join(' ').toLowerCase();
    return words.every(word => text.includes(word));
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
