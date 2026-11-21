import { modelLabel } from '../modelLabel';
import type { Depth, ProviderId } from '../../../shared/domain';
import type { RepoPreview } from '../../../shared/repository';
import { PROVIDER_LABELS } from '../preferences';
import { RepositoryFiles } from './RepositoryFiles';
import type { useAttachInventory, useAttachPreview } from './AttachReads';
import { AlwaysAllowSource } from './SourceApproval';
import './repository.css';

function ExactRequest({ preview, provider, depth }: { preview: RepoPreview; provider: ProviderId; depth: Depth }) {
  return <section className="repository-review attach-preview" aria-labelledby="attach-preview-title">
    <h3 id="attach-preview-title">Review provider request</h3>
    <p id="attach-preview-summary" role="status">
      {PROVIDER_LABELS[provider]} · {modelLabel(provider, preview)} · {depth} depth · {preview.files.length}
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
  allowed?: boolean;
  onAlwaysAllow?: (allowed: boolean) => void;
}

export function AttachReview({ inventory, request, selected, onFiles, depth, provider, allowed, onAlwaysAllow }: Props) {
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
    <RepositoryFiles key={inventory.snapshot?.workspace.id} files={snapshot.files} paths={selected} onChange={onFiles} />
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
    {request.preview && <>
      <ExactRequest preview={request.preview} provider={provider} depth={depth} />
      {onAlwaysAllow && <AlwaysAllowSource provider={provider} category="map" checked={allowed ?? false} onChange={onAlwaysAllow} />}
    </>}
  </>;
}
