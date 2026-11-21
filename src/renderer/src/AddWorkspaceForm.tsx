import { useState, type FormEvent } from 'react';
import type { AddWorkspaceInput, WorkspaceKind } from '../../shared/domain';
import { call } from './api';

interface Props {
  onAdded: () => Promise<void>;
  onError: (message: string) => void;
}

function toInput(kind: WorkspaceKind, value: string): AddWorkspaceInput {
  if (kind === 'git') return { kind, path: value };
  if (kind === 'topic') return { kind, title: value };
  const [owner = '', repo = '', ...rest] = value.trim().split('/');
  if (rest.length > 0 || !repo) throw new Error('Write the GitHub repository as owner/name.');
  return { kind, owner, repo };
}

const PLACEHOLDERS: Record<WorkspaceKind, string> = {
  git: '/path/to/repository',
  github: 'owner/name',
  topic: 'e.g. Photography',
};

export function AddWorkspaceForm({ onAdded, onError }: Props) {
  const [kind, setKind] = useState<WorkspaceKind>('topic');
  const [value, setValue] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await call('workspaces:add', toInput(kind, value));
      setValue('');
      await onAdded();
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  async function pickFolder() {
    try {
      const folder = await call('workspaces:pick-folder', null);
      if (folder) setValue(folder);
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} aria-label="Add workspace">
      <label>
        Kind{' '}
        <select value={kind} onChange={(event) => setKind(event.target.value as WorkspaceKind)}>
          <option value="git">Local Git repository</option>
          <option value="github">GitHub repository</option>
          <option value="topic">Topic</option>
        </select>
      </label>
      <input aria-label="Source" placeholder={PLACEHOLDERS[kind]} value={value} onChange={(event) => setValue(event.target.value)} />
      {kind === 'git' && (
        <button type="button" onClick={() => void pickFolder()}>
          Choose folder…
        </button>
      )}
      <button type="submit">Add workspace</button>
    </form>
  );
}
