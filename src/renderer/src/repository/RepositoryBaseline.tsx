import { useCallback, useState } from 'react';
import type { Depth, Workspace } from '../../../shared/domain';
import type { RepositoryFile, RepositoryInventory } from '../../../shared/repository';
import { call } from '../api';
import { preferredProvider } from '../preferences';
import { SetupProvider } from '../SetupProvider';
import { ReadState } from '../ReadState';
import { ReaderHeader } from '../reader/ReaderHeader';
import { useRead } from '../useRead';
import { defaultFiles, fitsFileSlice, MAX_BYTES, MAX_FILE_BYTES, MAX_FILES, retainFiles } from './fileSelection';
import { jobInProgress, mapJobKey, useMapJobs, type MapJob } from './MapJobs';
import { ProviderReview } from './ProviderReview';
import { useRepositoryGeneration } from './useRepositoryGeneration';

function FilePicker({ files, selected, onChange, disabled }: {
  files: RepositoryFile[]; selected: Set<string>; onChange: (paths: Set<string>) => void; disabled: boolean;
}) {
  const [filter, setFilter] = useState('');
  const shown = files.filter(file => file.path.toLowerCase().includes(filter.trim().toLowerCase()));
  const total = files.reduce((bytes, file) => bytes + (selected.has(file.path) ? file.bytes : 0), 0);

  function toggle(file: RepositoryFile) {
    const next = new Set(selected);
    if (next.delete(file.path)) return onChange(next);
    if (!fitsFileSlice(file, next.size, total)) return;
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
        const unavailable = !checked && !fitsFileSlice(file, selected.size, total);
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
  reviewJob?: MapJob;
}

function BaselineSelection({ snapshot, workspace, depth, onBack, reviewJob, reload }: {
  snapshot: RepositoryInventory; workspace: Workspace; depth: Depth; onBack: () => void;
  reviewJob?: MapJob; reload: () => void;
}) {
  const [provider, choose] = useState(() => reviewJob?.provider ?? preferredProvider());
  const [selected, setSelected] = useState(() =>
    reviewJob ? retainFiles(snapshot.files, new Set(reviewJob.files)) : defaultFiles(snapshot.files));
  const queue = useMapJobs();
  const runningMap = jobInProgress(queue.jobs.get(mapJobKey(workspace.id)));
  const generation = useRepositoryGeneration(preview => {
    const started = queue.start({ workspace, depth, provider, preview });
    if (started) onBack();
    return started;
  });
  const locked = Boolean(generation.pending || generation.preview || runningMap);
  const stale = generation.error?.code === 'STALE_INVENTORY';
  return <section className="sheet" aria-label="Repository file selection">
    <p className="repository-ref">Snapshot <code>{snapshot.commit}</code></p>
    {snapshot.partial && <p className="repository-notice" role="status">Partial coverage. Only the available files are listed.</p>}
    <SetupProvider provider={provider} onChange={choose} label="Mapping provider" disabled={locked} />
    <FilePicker files={snapshot.files} selected={selected} onChange={setSelected} disabled={locked} />
    <div className="actions">
      <button className="primary-btn" disabled={locked || !selected.size} onClick={() => void generation.inspect({
        workspaceId: workspace.id, depth, provider, selection: { kind: 'baseline', commit: snapshot.commit, paths: Array.from(selected) },
      })}>{generation.error && !stale ? 'Retry map preview' : 'Preview map request'}</button>
      {stale && <button onClick={reload}>Reload repository files</button>}
    </div>
    <ProviderReview generation={generation} provider={provider} depth={depth} workflow="map" disabled={runningMap} />
  </section>;
}

export function RepositoryBaseline({ workspace, depth, onDepth, onBack, reviewJob }: Props) {
  const query = useCallback(() => call('repo:files', { workspaceId: workspace.id }), [workspace.id]);
  const { result, refresh } = useRead(query);
  return <div className="repository-onboarding">
    <ReaderHeader workspace={workspace} depth={depth} onDepth={onDepth} onBack={onBack}
      label={workspace.name} title="Review repository files"
      summary="Choose files to map, then review the request before sending it to your selected CLI." />
    {result.status === 'ready'
      ? <BaselineSelection key={result.value.commit + '/' + depth} snapshot={result.value} workspace={workspace}
        depth={depth} onBack={onBack} reviewJob={reviewJob} reload={refresh} />
      : <ReadState label="Repository files" retry={refresh} message={result.status === 'error' ? result.message : undefined} />}
  </div>;
}
