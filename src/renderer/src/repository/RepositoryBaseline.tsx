import { useCallback, useState } from 'react';
import type { Depth, Workspace } from '../../../shared/domain';
import type { RepositoryInventory } from '../../../shared/repository';
import { call } from '../api';
import { preferredProvider } from '../preferences';
import { SetupProvider } from '../SetupProvider';
import { ReadState } from '../ReadState';
import { ReaderHeader } from '../reader/ReaderHeader';
import { useRead } from '../useRead';
import { defaultFiles, retainFiles } from './fileSelection';
import { jobInProgress, mapJobKey, useMapJobs, type MapJob } from './MapJobs';
import { RepositoryFiles } from './RepositoryFiles';
import { ProviderReview } from './ProviderReview';
import { hasRepositoryApproval, useRepositoryApproval } from './repositoryApproval';
import { RevokeSourceApproval } from './SourceApproval';
import { useRepositoryGeneration } from './useRepositoryGeneration';

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
  const approval = useRepositoryApproval(workspace.id, provider, 'map');
  const locked = Boolean(generation.pending || generation.preview || runningMap);
  const stale = generation.error?.code === 'STALE_INVENTORY';

  function prepare(send: boolean) {
    if (locked || stale || !selected.size) return;
    void generation.inspect({
      workspaceId: workspace.id, depth, provider, selection: { kind: 'baseline', commit: snapshot.commit, paths: Array.from(selected) },
    }, send ? () => hasRepositoryApproval(workspace.id, provider, 'map') : undefined);
  }

  return <section className="sheet" aria-label="Repository file selection">
    <p className="repository-ref">Snapshot <code>{snapshot.commit}</code></p>
    {snapshot.partial && <p className="repository-notice" role="status">Partial coverage. Only the available files are listed.</p>}
    {runningMap && <p role="status">Building the map. You can keep exploring or cancel above.</p>}
    {!selected.size && <p role="status">{snapshot.files.length ? 'Select files to prepare a map request.'
      : 'Commit eligible source files, then reload the repository file list.'}</p>}
    <fieldset disabled={locked} className="setup-controls">
      <RepositoryFiles files={snapshot.files} paths={selected} onChange={setSelected} />
      <details><summary>Mapping provider · {provider === 'claude' ? 'Claude Code' : 'Codex'}</summary>
        <SetupProvider provider={provider} onChange={choose} label="Mapping provider" />
      </details>
    </fieldset>
    {approval.allowed && <RevokeSourceApproval provider={provider} category="map" onRevoke={() => approval.setAllowed(false)} />}
    <div className="actions">
      {approval.allowed && <button className="primary-btn" disabled={locked || stale || !selected.size} onClick={() => prepare(true)}>Build map</button>}
      <button className={approval.allowed ? undefined : 'primary-btn'} disabled={locked || stale || !selected.size} onClick={() => prepare(false)}>
        {generation.error && !stale ? 'Retry map preview' : 'Preview map request'}
      </button>
      {(stale || !snapshot.files.length) && <button onClick={reload}>Reload repository files</button>}
    </div>
    <ProviderReview generation={generation} provider={provider} depth={depth} approval={approval} disabled={runningMap} />
  </section>;
}

export function RepositoryBaseline({ workspace, depth, onDepth, onBack, reviewJob }: Props) {
  const query = useCallback(() => call('repo:files', { workspaceId: workspace.id }), [workspace.id]);
  const { result, refresh } = useRead(query);
  return <div className="repository-onboarding">
    <ReaderHeader workspace={workspace} depth={depth} onDepth={onDepth} onBack={onBack}
      label={workspace.name} title="Review repository files"
      summary="Choose the files to learn about and review what your tutor will receive." />
    {result.status === 'ready'
      ? <BaselineSelection key={result.value.commit + '/' + depth} snapshot={result.value} workspace={workspace}
        depth={depth} onBack={onBack} reviewJob={reviewJob} reload={refresh} />
      : <ReadState label="Repository files" retry={refresh} message={result.status === 'error' ? result.message : undefined} />}
  </div>;
}
