import { useCallback, useState } from 'react';
import type { ProviderId } from '../../../shared/domain';
import type { IpcResponse } from '../../../shared/ipc';
import type { ChangeBrief, ChangeRef } from '../../../shared/repository';
import { call } from '../api';
import { preferredProvider } from '../preferences';
import { SetupProvider } from '../SetupProvider';
import { ReadState } from '../ReadState';
import { ProviderReview } from '../repository/ProviderReview';
import { useRepositoryGeneration } from '../repository/useRepositoryGeneration';
import { useRead } from '../useRead';
import { BriefChapters, ChangeFootprint } from './ChangeBrief';
import { DemoChanges } from './DemoChanges';
import { ReaderHeader, type ReaderProps } from './ReaderHeader';

type RepositoryChanges = IpcResponse<'repo:changes'>;

interface Props extends ReaderProps {
  selected?: ChangeRef;
  onSelect: (change: ChangeRef) => void;
  onFollowUp: (id: number) => void;
  onGenerated: () => void;
}

function reference({ kind, ref }: ChangeRef) {
  return kind === 'pr' ? 'PR #' + ref : 'Commit ' + ref;
}

function ChangeList({ workspaceId, selected, onSelect }: {
  workspaceId: string; selected?: ChangeRef; onSelect: (change: ChangeRef) => void;
}) {
  const query = useCallback(() => call('repo:changes', { workspaceId }), [workspaceId]);
  const { result, refresh } = useRead(query);
  if (result.status !== 'ready') return <ReadState label="Changes" retry={refresh}
    message={result.status === 'error' ? result.message : undefined} />;
  return <AvailableChanges changes={result.value} selected={selected} onSelect={onSelect} onRefresh={refresh} />;
}

function AvailableChanges({ changes, selected, onSelect, onRefresh }: {
  changes: RepositoryChanges; selected?: ChangeRef; onSelect: (change: ChangeRef) => void; onRefresh: () => void;
}) {
  return <section className="card" aria-labelledby="available-changes">
    <h2 id="available-changes">Available changes</h2>
    {changes.warning && <p className="repository-notice" role="status">{changes.warning}</p>}
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

function ChangeReader({ props, change }: { props: Props; change: ChangeRef }) {
  const { kind, ref } = change;
  const { workspace, depth, onLesson, onFollowUp, onGenerated } = props;
  const [provider, choose] = useState(preferredProvider);
  const [generatedBrief, setGeneratedBrief] = useState<{ provider: ProviderId; brief: ChangeBrief }>();
  const fresh = generatedBrief?.provider === provider ? generatedBrief.brief : undefined;
  const query = useCallback(() => call('repo:saved', { workspaceId: workspace.id, kind, ref, depth, provider }),
    [workspace.id, kind, ref, depth, provider]);
  const { result, refresh } = useRead(query);
  const generation = useRepositoryGeneration(generated => {
    if (generated.kind !== 'change') throw new Error('Expected a change brief.');
    setGeneratedBrief({ provider, brief: generated.brief });
    onGenerated();
  });
  const brief = fresh ?? (result.status === 'ready' ? result.value : undefined);
  function inspect() {
    return generation.inspect({ workspaceId: workspace.id, depth, provider, selection: { kind, ref } });
  }
  return <>
    <ReaderHeader {...props} label={'Change brief / ' + workspace.name + ' / ' + reference(change)}
      title={brief?.title ?? reference(change)} summary={brief?.summary ?? 'Review the available diff before generating a change brief.'} />
    {brief && <div className="reader reader-layout"><BriefChapters brief={brief} />
      <ChangeFootprint brief={brief} onLesson={onLesson} onFollowUp={onFollowUp} /></div>}
    <section className="sheet change-source" aria-label="Generation source">
      {brief && <p className="smallprint" role="status">{fresh ? 'Brief generated' : 'Saved brief · available offline'}</p>}
      {result.status === 'loading' && !fresh && <p role="status">Looking for a saved brief…</p>}
      {result.status === 'error' && !fresh && <div>
        <p role="alert">{result.message}</p><button onClick={refresh}>Retry saved brief</button>
      </div>}
      <SetupProvider provider={provider} onChange={choose} label="Brief provider" disabled={Boolean(generation.pending || generation.preview)} />
      <button disabled={Boolean(generation.pending || generation.preview)} onClick={() => void inspect()}>
        {brief ? 'Refresh diff preview' : 'Preview diff request'}
      </button>
      <ProviderReview generation={generation} provider={provider} depth={depth} workflow="explain" />
    </section>
    <details className="change-source"><summary>Browse another change</summary>
      <ChangeList workspaceId={workspace.id} selected={change} onSelect={props.onSelect} /></details>
  </>;
}

function LiveChanges(props: Props) {
  const { selected, onSelect } = props;
  if (selected) return <ChangeReader key={selected.kind + '/' + selected.ref + '/' + props.depth} props={props} change={selected} />;
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
