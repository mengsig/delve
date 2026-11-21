import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Workspace } from '../../shared/domain';
import { filterWorkspaces, moveIndex } from './switcher';
import './setup.css';

interface Props {
  workspaces: Workspace[];
  activeId: string | null;
  onSelect: (id: string) => Promise<void>;
  onClose: () => void;
  onAdd: () => void;
}

const KIND_LABELS = { git: 'Local Git repository', github: 'GitHub repository', topic: 'Topic' };
const OPTIONS_ID = 'workspace-switcher-options';
const optionId = (id: string) => `workspace-option-${id}`;

function SwitcherSearch({ workspaces, activeId, onChoose, pending }: Pick<Props, 'workspaces' | 'activeId'> & {
  onChoose: (id: string) => void;
  pending: boolean;
}) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(() => Math.max(0, workspaces.findIndex((item) => item.id === activeId)));
  const matches = filterWorkspaces(workspaces, query);
  const current = Math.min(highlight, matches.length - 1);
  const highlighted = matches[current];
  const selected = useRef<HTMLLIElement>(null);

  useEffect(() => { selected.current?.scrollIntoView({ block: 'nearest' }); }, [highlighted?.id]);

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (pending || event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length) setHighlight(moveIndex(current, event.key === 'ArrowDown' ? 1 : -1, matches.length));
    } else if (event.key === 'Enter' && highlighted) {
      event.preventDefault();
      onChoose(highlighted.id);
    }
  }

  return (
    <>
      <input type="text" role="combobox" aria-label="Find a workspace" aria-expanded="true" aria-controls={OPTIONS_ID}
        aria-autocomplete="list" aria-activedescendant={highlighted ? optionId(highlighted.id) : undefined}
        autoComplete="off" placeholder="Find a workspace…" value={query} readOnly={pending}
        onKeyDown={navigate} onChange={(event) => { setQuery(event.target.value); setHighlight(0); }} />
      <ul id={OPTIONS_ID} className="palette-list" role="listbox" aria-label="Workspaces to switch to" aria-busy={pending}>
        {matches.map((workspace, index) => (
          <li key={workspace.id} id={optionId(workspace.id)} role="option" aria-selected={index === current}
            ref={index === current ? selected : undefined} onClick={() => onChoose(workspace.id)}>
            <div>
              <strong>{workspace.name}</strong>
              <small>{KIND_LABELS[workspace.kind]}{workspace.kind === 'git' && ` · ${workspace.source}`}</small>
            </div>
            {workspace.id === activeId && <span className="tag">Current</span>}
          </li>
        ))}
      </ul>
      {matches.length === 0 && <p className="palette-empty" role="status">{query ? `No workspace matches “${query}”.` : 'No workspaces yet.'}</p>}
    </>
  );
}

export function WorkspaceSwitcher({ workspaces, activeId, onSelect, onClose, onAdd }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useLayoutEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    if (!element) throw new Error('The workspace switcher needs a mounted dialog.');
    const finder = element.querySelector('input');
    if (!finder) throw new Error('The workspace switcher needs a search field.');
    element.showModal();
    finder.focus();
    return () => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  async function choose(id: string) {
    if (pending) return;
    if (id === activeId) return onClose();
    setError('');
    setPending(true);
    try {
      await onSelect(id);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog className="workspace-palette" ref={dialog} aria-labelledby="switcher-title"
      onCancel={(event) => { event.preventDefault(); if (!pending) onClose(); }}>
      <div className="palette-header">
        <h2 id="switcher-title">Switch workspace</h2>
        <button type="button" className="palette-close" disabled={pending} aria-label="Close switcher" onClick={onClose}>Esc</button>
      </div>
      <SwitcherSearch workspaces={workspaces} activeId={activeId} onChoose={choose} pending={pending} />
      {error && <p className="setup-error" role="alert">{error}</p>}
      <div className="palette-footer">
        <span><kbd>↑</kbd> <kbd>↓</kbd> to navigate · <kbd>Enter</kbd> to open</span>
        <button type="button" disabled={pending} onClick={() => { onClose(); onAdd(); }}>+ Add workspace</button>
      </div>
    </dialog>
  );
}
