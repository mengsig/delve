import { useEffect, useRef } from 'react';
import type { WorkspaceList } from '../../shared/domain';

const IS_MAC = navigator.userAgent.includes('Mac');
export const SWITCHER_SHORTCUT = IS_MAC ? '⌘K' : 'Ctrl+K';

/** True for Ctrl+K (Cmd+K on macOS), the switcher shortcut. */
export function isSwitcherShortcut(event: KeyboardEvent): boolean {
  const modifier = IS_MAC ? event.metaKey : event.ctrlKey;
  return modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
}

interface Props {
  list: WorkspaceList;
  onSwitch: (id: string) => void;
}

/** A keyboard-reachable workspace switcher; the shortcut focuses it from anywhere. */
export function WorkspaceSwitcher({ list, onSwitch }: Props) {
  const select = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSwitcherShortcut(event)) return;
      event.preventDefault();
      select.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (list.workspaces.length === 0) return null;
  return (
    <label>
      Workspace{' '}
      <select
        ref={select}
        aria-label="Switch workspace"
        aria-keyshortcuts={IS_MAC ? 'Meta+K' : 'Control+K'}
        value={list.activeId ?? ''}
        onChange={(event) => onSwitch(event.target.value)}
      >
        {list.activeId === null && <option value="">Choose a workspace</option>}
        {list.workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>{' '}
      <kbd className="muted">{SWITCHER_SHORTCUT}</kbd>
    </label>
  );
}
