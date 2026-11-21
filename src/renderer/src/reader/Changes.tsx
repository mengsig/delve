import { useCallback, useState } from 'react';
import type { IpcResponse } from '../../../shared/ipc';
import type { ChangeRef } from '../../../shared/repository';
import { call } from '../api';
import { preferredProvider } from '../preferences';
import { SetupProvider } from '../SetupProvider';
import { ReadState } from '../ReadState';
import { changeJobKey, jobInProgress, useMapJobs, useRepositoryCompletion, type ChangeJob } from '../repository/MapJobs';
import { CopyGitHubLogin, ProviderReview } from '../repository/ProviderReview';
import { useRepositoryGeneration } from '../repository/useRepositoryGeneration';
import { useRead } from '../useRead';
import { BriefChapters, ChangeFootprint } from './ChangeBrief';
import { DemoChanges } from './DemoChanges';
import { ReaderHeader, type ReaderProps } from './ReaderHeader';

type RepositoryChanges = IpcResponse<'repo:changes'>;

interface Props extends ReaderProps {
  selected?: ChangeRef;
  openedJob?: ChangeJob;
  onSelect: (change: ChangeRef) => void;
  onFollowUp: (id: number) => void;
}

function reference({ kind, ref }: ChangeRef) {
  return kind === 'pr' ? 'PR #' + ref : 'Commit ' + ref;
}

function ChangeList({ workspaceId, selected, onSelect }: {
  workspaceId: string; selected?: ChangeRef; onSelect: (change: ChangeRef) => void;
}) {
  const query = useCallback(() => call('repo:changes', { workspaceId }), [workspaceId]);
  const { result, refresh } = useRead(query);
  if (result.status !== 'ready') return <>
    <ReadState label="Changes" retry={refresh} message={result.status === 'error' ? result.message : undefined} />
    {result.status === 'error' && <CopyGitHubLogin message={result.message} />}
  </>;
  return <AvailableChanges changes={result.value} selected={selected} onSelect={onSelect} onRefresh={refresh} />;
}

function AvailableChanges({ changes, selected, onSelect, onRefresh }: {
  changes: RepositoryChanges; selected?: ChangeRef; onSelect: (change: ChangeRef) => void; onRefresh: () => void;
}) {
  return <section className="card" aria-labelledby="available-changes">
    <h2 id="available-changes">Available changes</h2>
    {changes.warning && <div className="repository-notice">
      <p role="status">{changes.warning}</p>
      <CopyGitHubLogin message={changes.warning} />
    </div>}
    {changes.changes.length > 0 ? <ul className="repository-list">
      {changes.changes.map(change => <li key={change.kind + '/' + change.ref}>
        <button data-change-kind={change.kind} data-change-ref={change.ref}
          aria-current={selected?.kind === change.kind && selected.ref === change.ref ? 'true' : undefined}
          onClick={() => onSelect(change)}>
          <strong>{change.title}</strong><small>{reference(change)}</small>
        </button>
      </li>)}
    </ul> : <p>No commits or pull requests are available.</p>}
    <button onClick={onRefresh}>Refresh changes</button>
  </section>;
}

function ChangeReader({ props, change, openedJob }: { props: Props; change: ChangeRef; openedJob?: ChangeJob }) {
  const { kind, ref } = change;
  const { workspace, depth, onLesson, onFollowUp } = props;
  const [provider, choose] = useState(() => openedJob?.provider ?? preferredProvider());
  const query = useCallback(() => call('repo:saved', { workspaceId: workspace.id, kind, ref, depth, provider }),
    [workspace.id, kind, ref, depth, provider]);
  const { result, refresh } = useRead(query);
  useRepositoryCompletion(workspace.id, refresh);
  const queue = useMapJobs();
  const job = queue.jobs.get(changeJobKey(workspace.id, change, depth));
  const previous = job ?? openedJob;
  const running = jobInProgress(job);
  const generation = useRepositoryGeneration(preview => queue.startChange({ workspace, depth, provider, change, preview }));
  const brief = result.status === 'ready' ? result.value : undefined;
  const locked = running || Boolean(generation.pending || generation.preview);
  function inspect() {
    return generation.inspect({ workspaceId: workspace.id, depth, provider, selection: { kind, ref } });
  }
  let previewLabel = brief ? 'Refresh diff preview' : 'Preview diff request';
  if (generation.error?.action === 'provider') previewLabel = 'Review diff with selected provider';
  else if (generation.error?.action === 'review') previewLabel = 'Review diff again';
  else if (generation.error) previewLabel = 'Retry diff preview';
  else if (previous?.phase === 'failed' || previous?.phase === 'cancelled') {
    previewLabel = 'Review diff to retry';
  }
  return <>
    <ReaderHeader {...props} label={'Change brief / ' + workspace.name + ' / ' + reference(change)}
      title={brief?.title ?? reference(change)} summary={brief?.summary ?? 'Review the available diff before generating a change brief.'} />
    {brief && <div className="reader reader-layout"><BriefChapters brief={brief} />
      <ChangeFootprint brief={brief} onLesson={onLesson} onFollowUp={onFollowUp} /></div>}
    <section className="sheet change-source" aria-label="Generation source">
      {brief && <p className="smallprint" role="status">Saved brief · available offline</p>}
      {result.status === 'loading' && <p role="status">Looking for a saved brief…</p>}
      {result.status === 'error' && <div>
        <p role="alert">{result.message}</p><button onClick={refresh}>Retry saved brief</button>
      </div>}
      <SetupProvider provider={provider} onChange={choose} label="Brief provider" disabled={locked} />
      <button disabled={locked} onClick={() => void inspect()}>
        {previewLabel}
      </button>
      <ProviderReview generation={generation} provider={provider} depth={depth} workflow="explain" disabled={running} />
    </section>
    <details className="change-source"><summary>Browse another change</summary>
      <ChangeList workspaceId={workspace.id} selected={change} onSelect={props.onSelect} /></details>
  </>;
}

function LiveChanges(props: Props) {
  const { selected, onSelect, openedJob } = props;
  if (selected) {
    const key = changeJobKey(props.workspace.id, selected, props.depth);
    return <ChangeReader key={key} props={props} change={selected} openedJob={openedJob?.key === key ? openedJob : undefined} />;
  }
  return <>
    <ReaderHeader {...props} label={props.workspace.name} title="Repository changes"
      summary="Review a commit or pull request and follow the concepts it touches." />
    <ChangeList workspaceId={props.workspace.id} onSelect={onSelect} />
  </>;
}

export function Changes(props: Props) {
  if (props.graph.demo || props.workspace.kind === 'topic') return <DemoChanges {...props} />;
  return <LiveChanges {...props} />;
}
