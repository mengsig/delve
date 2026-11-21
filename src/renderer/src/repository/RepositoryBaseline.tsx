import { useCallback, useState } from 'react';
import type { Depth, Workspace } from '../../../shared/domain';
import type { RepositoryFile, RepositoryInventory } from '../../../shared/repository';
import { call } from '../api';
import { preferredProvider } from '../preferences';
import { SetupProvider } from '../SetupProvider';
import { ReadState } from '../ReadState';
import { ReaderHeader } from '../reader/ReaderHeader';
import { useRead } from '../useRead';
import { ProviderReview } from './ProviderReview';
import { useRepositoryGeneration } from './useRepositoryGeneration';

const MAX_FILES = 128;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_BYTES = 1024 * 1024;

function priority(path: string) {
  if (/^readme(?:\.|$)/i.test(path)) return 0;
  if (/^(?:docs\/|package\.json$|Cargo\.toml$|pyproject\.toml$|go\.mod$)/i.test(path)) return 1;
  if (/(?:^|\/)(?:main|index|app)\.[a-z0-9]+$/i.test(path)) return 2;
  return 3;
}

function defaultFiles(files: RepositoryFile[]) {
  const ranked = files.filter(file => file.bytes <= MAX_FILE_BYTES)
    .sort((a, b) => priority(a.path) - priority(b.path) || a.path.localeCompare(b.path));
  const selected = new Set<string>();
  let bytes = 0;
  for (const file of ranked) {
    if (selected.size === 16) break;
    if (bytes + file.bytes > MAX_BYTES) continue;
    if (priority(file.path) === 3 && selected.size > 0) break;
    selected.add(file.path);
    bytes += file.bytes;
  }
  return selected;
}

function FilePicker({ files, selected, onChange, disabled }: {
  files: RepositoryFile[]; selected: Set<string>; onChange: (paths: Set<string>) => void; disabled: boolean;
}) {
  const [filter, setFilter] = useState('');
  const shown = files.filter(file => file.path.toLowerCase().includes(filter.trim().toLowerCase()));
  const total = files.reduce((bytes, file) => bytes + (selected.has(file.path) ? file.bytes : 0), 0);

  function toggle(file: RepositoryFile) {
    const next = new Set(selected);
    if (next.delete(file.path)) return onChange(next);
    if (file.bytes > MAX_FILE_BYTES || total + file.bytes > MAX_BYTES || next.size >= MAX_FILES) return;
    next.add(file.path);
    onChange(next);
  }
  return <fieldset className="setup-controls" disabled={disabled}>
    <legend>Files to include</legend>
    <div className="formrow">
      <label htmlFor="repository-file-filter">Filter files</label>
      <input id="repository-file-filter" value={filter} onChange={event => setFilter(event.target.value)} />
    </div>
    <p className="smallprint" role="status">{selected.size} of {MAX_FILES} files selected · {total.toLocaleString()} of {MAX_BYTES.toLocaleString()} bytes</p>
    <p className="smallprint">Individual files can be up to {MAX_FILE_BYTES.toLocaleString()} bytes.</p>
    {shown.length > 0 ? <ul className="repository-files" aria-label="Repository files">
      {shown.map(file => {
        const checked = selected.has(file.path);
        const unavailable = !checked && (file.bytes > MAX_FILE_BYTES || total + file.bytes > MAX_BYTES || selected.size >= MAX_FILES);
        return <li key={file.path}><label>
          <input type="checkbox" checked={checked} disabled={unavailable} aria-label={file.path} onChange={() => toggle(file)} />
          <code>{file.path}</code><small>{file.bytes.toLocaleString()} bytes</small>
        </label></li>;
      })}
    </ul> : <p role="status">{filter ? 'No files match this filter.' : 'No eligible text files were found.'}</p>}
  </fieldset>;
}

interface Props {
  workspace: Workspace;
  depth: Depth;
  onDepth: (depth: Depth) => void;
  onBack: () => void;
  onMapped: () => void;
}

function BaselineSelection({ snapshot, workspaceId, depth, onMapped }: {
  snapshot: RepositoryInventory; workspaceId: string; depth: Depth; onMapped: () => void;
}) {
  const [provider, choose] = useState(preferredProvider);
  const [selected, setSelected] = useState(() => defaultFiles(snapshot.files));
  const generation = useRepositoryGeneration(result => {
    if (result.kind !== 'baseline') throw new Error('Expected a repository atlas.');
    onMapped();
  });
  const locked = Boolean(generation.pending || generation.preview);
  return <section className="sheet" aria-label="Repository file selection">
    <p className="repository-ref">Snapshot <code>{snapshot.commit}</code></p>
    {snapshot.partial && <p className="repository-notice" role="status">Partial coverage. Only the available files are listed.</p>}
    <SetupProvider provider={provider} onChange={choose} label="Mapping provider" disabled={locked} />
    <FilePicker files={snapshot.files} selected={selected} onChange={setSelected} disabled={locked} />
    <div className="actions">
      <button className="primary-btn" disabled={locked || !selected.size} onClick={() => void generation.inspect({
        workspaceId, depth, provider, selection: { kind: 'baseline', commit: snapshot.commit, paths: Array.from(selected) },
      })}>Preview map request</button>
    </div>
    <ProviderReview generation={generation} provider={provider} depth={depth} workflow="map" />
  </section>;
}

export function RepositoryBaseline({ workspace, depth, onDepth, onBack, onMapped }: Props) {
  const query = useCallback(() => call('repo:files', { workspaceId: workspace.id }), [workspace.id]);
  const { result, refresh } = useRead(query);
  return <div className="repository-onboarding">
    <ReaderHeader workspace={workspace} depth={depth} onDepth={onDepth} onBack={onBack}
      label={workspace.name} title="Review repository files"
      summary="Choose files for your starting map. Review the request before sharing it with your selected CLI." />
    {result.status === 'ready'
      ? <BaselineSelection key={result.value.commit + '/' + depth} snapshot={result.value} workspaceId={workspace.id}
        depth={depth} onMapped={onMapped} />
      : <ReadState label="Repository files" retry={refresh} message={result.status === 'error' ? result.message : undefined} />}
  </div>;
}
