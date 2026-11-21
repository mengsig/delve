import { useState } from 'react';
import type { Depth, ProviderId } from '../../../shared/domain';
import type { RepositoryFile, RepoPreview } from '../../../shared/repository';
import { PROVIDER_LABELS } from '../preferences';
import { fitsFileSlice, MAX_BYTES, MAX_FILE_BYTES, MAX_FILES } from './fileSelection';
import type { useAttachInventory, useAttachPreview } from './AttachReads';
import './repository.css';

function AttachFiles({ files, paths, onChange }: {
  files: RepositoryFile[]; paths: Set<string>; onChange: (paths: Set<string>) => void;
}) {
  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();
  const shown = files.filter(file => file.path.toLowerCase().includes(query));
  const bytes = files.reduce((total, file) => paths.has(file.path) ? total + file.bytes : total, 0);

  function toggle(file: RepositoryFile) {
    const next = new Set(paths);
    if (!next.delete(file.path)) {
      if (!fitsFileSlice(file, paths.size, bytes)) return;
      next.add(file.path);
    }
    onChange(next);
  }

  return <details className="attach-files">
    <summary>Edit files ({paths.size} selected)</summary>
    <div className="formrow">
      <label htmlFor="attach-file-filter">Filter repository files</label>
      <input id="attach-file-filter" value={filter} onChange={event => setFilter(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
    </div>
    <p className="smallprint" role="status">
      {paths.size} of {MAX_FILES} files · {bytes.toLocaleString()} of {MAX_BYTES.toLocaleString()} bytes.
      Each file can be up to {MAX_FILE_BYTES.toLocaleString()} bytes.
    </p>
    {shown.length ? <ul className="repository-files" aria-label="Repository files">
      {shown.map(file => <li key={file.path}><label>
        <input type="checkbox" aria-label={file.path} checked={paths.has(file.path)}
          disabled={!paths.has(file.path) && !fitsFileSlice(file, paths.size, bytes)} onChange={() => toggle(file)} />
        <code>{file.path}</code><small>{file.bytes.toLocaleString()} bytes</small>
      </label></li>)}
    </ul> : <p role="status">No files match this filter.</p>}
  </details>;
}

function ExactRequest({ preview, provider, depth }: { preview: RepoPreview; provider: ProviderId; depth: Depth }) {
  return <section className="repository-review attach-preview" aria-labelledby="attach-preview-title">
    <h3 id="attach-preview-title">Review provider request</h3>
    <p id="attach-preview-summary" role="status">
      {PROVIDER_LABELS[provider]} · {preview.model} · {depth} depth · {preview.files.length}
      {preview.files.length === 1 ? ' file' : ' files'} · {preview.bytes.toLocaleString()} bytes in request
    </p>
    <p>Commit <code>{preview.commit}</code></p>
    {preview.partial && <p className="smallprint">{preview.coverageNote ?? 'This map will cover the files shown here.'}</p>}
    <ul className="attach-file-names" aria-label="Files included in the request" tabIndex={0}>
      {preview.files.map(path => <li key={path}><code>{path}</code></li>)}
    </ul>
    <details><summary>Exact request</summary><pre aria-label="Exact provider request" tabIndex={0}>{preview.prompt}</pre></details>
    <p className="smallprint">“Add and build map” sends this request to {PROVIDER_LABELS[provider]}.</p>
  </section>;
}

interface Props {
  inventory: ReturnType<typeof useAttachInventory>;
  request: ReturnType<typeof useAttachPreview>;
  selected: Set<string>;
  onFiles: (paths: Set<string>) => void;
  depth: Depth;
  provider: ProviderId;
}

export function AttachReview({ inventory, request, selected, onFiles, depth, provider }: Props) {
  const snapshot = inventory.snapshot?.inventory;
  if (inventory.pending) return <p role="status">Reading the repository file list…</p>;
  if (inventory.error) return <div className="attach-feedback">
    <p className="setup-error" role="alert">Could not read repository files. {inventory.error}</p>
    <p className="smallprint">Check the repository source and access, then retry or add it without mapping.</p>
    {inventory.canRetry && <button type="button" onClick={inventory.retry}>Retry reading files</button>}
  </div>;
  if (!snapshot) return null;
  if (!snapshot.files.length) return <p role="status">No eligible files in this snapshot. Commit source files to build a map, or add the repository as it is.</p>;

  return <>
    <AttachFiles key={inventory.snapshot?.workspace.id} files={snapshot.files} paths={selected} onChange={onFiles} />
    {!selected.size && <p role="status">Select at least one file to prepare a map request.</p>}
    {request.pending && <p role="status">Preparing the exact provider request…</p>}
    {request.error && <div className="attach-feedback">
      <p className="setup-error" role="alert">Could not prepare the map request. {request.error}</p>
      <p className="smallprint">Edit the selected files or refresh the repository snapshot and try again.</p>
      <div className="actions">
        <button type="button" onClick={request.retry}>Retry preparing request</button>
        <button type="button" disabled={!inventory.canRetry} onClick={inventory.retry}>Refresh repository files</button>
      </div>
    </div>}
    {request.preview && <ExactRequest preview={request.preview} provider={provider} depth={depth} />}
  </>;
}
