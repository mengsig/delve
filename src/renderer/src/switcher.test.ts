import { describe, expect, it } from 'vitest';
import type { Command } from './commands';
import { filterCommands, isSwitcherShortcut, moveIndex } from './switcher';

const key = (over: Partial<Parameters<typeof isSwitcherShortcut>[0]>) => ({ key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });
const item = (id: string, label: string, search: string): Command => ({ id, label, search, detail: 'Workspace', open: () => undefined });

describe('switcher shortcut', () => {
  it('is Ctrl+K off macOS and Cmd+K on macOS, with no other modifier', () => {
    expect(isSwitcherShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isSwitcherShortcut(key({ ctrlKey: true, key: 'K' }), false)).toBe(true);
    expect(isSwitcherShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isSwitcherShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isSwitcherShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isSwitcherShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isSwitcherShortcut(key({ ctrlKey: true, key: 'j' }), false)).toBe(false);
  });
});

describe('switcher filtering and movement', () => {
  const list = [item('1', 'Photography', 'Photography'), item('2', 'octo/site', 'octo/site'), item('3', 'delve', '/home/me/src/delve')];

  it('matches every word against name or source, case-insensitively', () => {
    expect(filterCommands(list, '').map((w) => w.id)).toEqual(['1', '2', '3']);
    expect(filterCommands(list, 'OCTO').map((w) => w.id)).toEqual(['2']);
    expect(filterCommands(list, 'src delve').map((w) => w.id)).toEqual(['3']);
    expect(filterCommands(list, 'zzz')).toEqual([]);
  });

  it('wraps the highlight in both directions and has none for an empty list', () => {
    expect(moveIndex(-1, 1, 3)).toBe(0);
    expect(moveIndex(-1, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });
});
