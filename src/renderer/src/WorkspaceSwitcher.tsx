import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Command } from './commands';
import { filterCommands, moveIndex } from './switcher';
import './setup.css';

interface Props {
  commands: Command[];
  onClose: () => void;
  onAdd: () => void;
}

const OPTIONS_ID = 'workspace-switcher-options';
const optionId = (id: string) => `workspace-option-${encodeURIComponent(id)}`;

function SwitcherSearch({ commands, onChoose, pending }: Pick<Props, 'commands'> & {
  onChoose: (command: Command) => void;
  pending: boolean;
}) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(() => Math.max(0, commands.findIndex(item => item.current)));
  const matches = filterCommands(commands, query);
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
      onChoose(highlighted);
    }
  }

  return (
    <>
      <input type="text" role="combobox" aria-label="Search workspaces, views and lessons" aria-expanded="true" aria-controls={OPTIONS_ID}
        aria-autocomplete="list" aria-activedescendant={highlighted ? optionId(highlighted.id) : undefined}
        autoComplete="off" placeholder="Search workspaces, views and lessons…" value={query} readOnly={pending}
        onKeyDown={navigate} onChange={(event) => { setQuery(event.target.value); setHighlight(0); }} />
      <ul id={OPTIONS_ID} className="palette-list" role="listbox" aria-label="Destinations" aria-busy={pending}>
        {matches.map((command, index) => (
          <li key={command.id} id={optionId(command.id)} role="option" aria-selected={index === current}
            ref={index === current ? selected : undefined} onClick={() => onChoose(command)}>
            <div>
              <strong>{command.label}</strong>
              <small>{command.detail}</small>
            </div>
            {command.current && <span className="tag">Current</span>}
          </li>
        ))}
      </ul>
      {matches.length === 0 && <p className="palette-empty" role="status">No matches. Try another name or add a workspace.</p>}
    </>
  );
}

export function WorkspaceSwitcher({ commands, onClose, onAdd }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const dismiss = useEffectEvent(onClose);
  useLayoutEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    if (!element) throw new Error('The workspace switcher needs a mounted dialog.');
    const finder = element.querySelector('input');
    if (!finder) throw new Error('The workspace switcher needs a search field.');
    function yieldToDialog(event: Event) {
      if (event.target !== element && event.target instanceof HTMLDialogElement && (event as ToggleEvent).newState === 'open') {
        element?.close();
        dismiss();
      }
    }
    document.addEventListener('beforetoggle', yieldToDialog, true);
    element.showModal();
    finder.focus();
    return () => {
      document.removeEventListener('beforetoggle', yieldToDialog, true);
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected && !document.querySelector('dialog[open]') && !document.activeElement?.matches('#source-input')) opener.focus({ preventScroll: true });
    };
  }, []);

  async function choose(command: Command) {
    if (pending) return;
    setError('');
    setPending(true);
    try {
      await command.open();
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
        <h2 id="switcher-title">Go to…</h2>
        <button type="button" className="palette-close" disabled={pending} aria-label="Close switcher" onClick={onClose}>Esc</button>
      </div>
      <SwitcherSearch commands={commands} onChoose={choose} pending={pending} />
      {error && <p className="setup-error" role="alert">{error}</p>}
      {pending && <p role="status">Opening…</p>}
      <div className="palette-footer">
        <span><kbd>↑</kbd> <kbd>↓</kbd> to navigate · <kbd>Enter</kbd> to open</span>
        <button type="button" disabled={pending} onClick={() => { onClose(); onAdd(); }}>+ Add workspace</button>
      </div>
    </dialog>
  );
}
