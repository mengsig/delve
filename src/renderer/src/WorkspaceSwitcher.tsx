import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { WorkspaceList } from '../../shared/domain';
import { filterWorkspaces, isSwitcherShortcut, moveIndex } from './switcher';

const IS_MAC = navigator.userAgent.includes('Mac');
const SHORTCUT_LABEL = IS_MAC ? '⌘K' : 'Ctrl+K';
const ARIA_SHORTCUT = IS_MAC ? 'Meta+K' : 'Control+K';
const LISTBOX_ID = 'workspace-switcher-options';
const optionId = (id: string): string => `workspace-option-${id}`;

interface Props {
  list: WorkspaceList;
  onSwitch: (id: string) => void;
}

/** The filter box and listbox inside the switcher; remounted on each open so it starts fresh. */
function SwitcherOptions({ list, onChoose }: { list: WorkspaceList; onChoose: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(() => Math.max(list.workspaces.findIndex((w) => w.id === list.activeId), 0));
  const matches = filterWorkspaces(list.workspaces, query);
  const current = Math.min(highlight, matches.length - 1);
  const highlighted = matches[current];

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight(moveIndex(current, event.key === 'ArrowDown' ? 1 : -1, matches.length));
      return;
    }
    if (event.key !== 'Enter' || highlighted === undefined) return;
    event.preventDefault();
    onChoose(highlighted.id);
  };

  return (
    <>
      <input
        type="text" role="combobox" aria-label="Find a workspace" aria-expanded="true" aria-controls={LISTBOX_ID}
        aria-autocomplete="list" aria-activedescendant={highlighted ? optionId(highlighted.id) : undefined}
        value={query} autoFocus onKeyDown={onKeyDown}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
      />
      <ul id={LISTBOX_ID} role="listbox" aria-label="Workspaces to switch to">
        {matches.map((workspace, index) => (
          <li key={workspace.id} id={optionId(workspace.id)} role="option" aria-selected={index === current}
            className={index === current ? 'highlighted' : undefined} onClick={() => onChoose(workspace.id)}>
            {workspace.name}
            {workspace.id === list.activeId && <span className="muted"> (active)</span>}
          </li>
        ))}
      </ul>
      {matches.length === 0 && <p className="muted">No workspace matches “{query}”.</p>}
    </>
  );
}

/**
 * A modal workspace switcher: Ctrl/Cmd+K or the button opens it, typing filters, arrow keys move the
 * highlight, Enter switches and Escape closes. Built on <dialog>, so focus stays inside while open.
 */
export function WorkspaceSwitcher({ list, onSwitch }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [session, setSession] = useState(0);
  const hasWorkspaces = list.workspaces.length > 0;

  const open = useCallback((): void => {
    const element = dialog.current;
    if (element === null || element.open || !hasWorkspaces) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSession((n) => n + 1);
    element.showModal();
  }, [hasWorkspaces]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSwitcherShortcut(event, IS_MAC)) return;
      event.preventDefault();
      open();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const choose = (id: string): void => {
    dialog.current?.close();
    if (id !== list.activeId) onSwitch(id);
  };

  return (
    <>
      <button type="button" aria-haspopup="dialog" aria-keyshortcuts={ARIA_SHORTCUT} onClick={open} hidden={!hasWorkspaces}>
        Switch workspace <kbd className="muted">{SHORTCUT_LABEL}</kbd>
      </button>
      <dialog ref={dialog} aria-labelledby="switcher-title" onClose={() => opener.current?.focus()}>
        <h2 id="switcher-title">Switch workspace</h2>
        {session > 0 && <SwitcherOptions key={session} list={list} onChoose={choose} />}
      </dialog>
    </>
  );
}
