import { useCallback, useState } from 'react';
import type { ProviderId } from '../../../shared/domain';
import type { IpcResponse } from '../../../shared/ipc';
import type { ChangeBrief, ChangeRef } from '../../../shared/repository';
import { call } from '../api';
import { preferredProvider, PROVIDER_LABELS } from '../preferences';
import { SetupProvider } from '../SetupProvider';
import { ReadState } from '../ReadState';
import { ProviderReview } from '../repository/ProviderReview';
import { useRepositoryGeneration } from '../repository/useRepositoryGeneration';
import { useRead } from '../useRead';
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

function BriefContent({ brief, saved, onLesson, onFollowUp }: {
  brief: ChangeBrief; saved: boolean; onLesson: (id: number) => void; onFollowUp: (id: number) => void;
}) {
  return <>
    <p className="smallprint" role="status">{saved ? 'Saved brief · available offline' : 'Brief generated'}</p>
    <h2 className="repository-brief-title">{brief.title}</h2>
    <p>{brief.summary}</p>
    {brief.partial && <p className="repository-notice" role="status">Partial coverage. This brief uses the available portion of the diff.</p>}
    <section className="chapter">
      <h3>What changed</h3><p>{brief.what}</p>
      <h3>Why it matters</h3><p>{brief.why}</p>
      <div className="grid2 reader-comparison" aria-label="Before and after">
        <div className="note"><strong>Before</strong><p>{brief.before}</p></div>
        <div className="note"><strong>After</strong><p>{brief.after}</p></div>
      </div>
    </section>
    <section className="chapter">
      <h3>Change footprint</h3>
      <p className="repository-ref">Source revision <code>{brief.commit}</code></p>
      {brief.files.length > 0 && <details><summary>Files in this brief ({brief.files.length})</summary>
        <ul>{brief.files.map(path => <li key={path}><code>{path}</code></li>)}</ul>
      </details>}
      {brief.touched.length > 0 && <ul aria-label="Concepts touched">
        {brief.touched.map(concept => <li key={concept.id}><button onClick={() => onLesson(concept.id)}>{concept.title}</button></li>)}
      </ul>}
      <div className="impact" aria-label="Suggested next step">
        <span className="plate">Suggested next step</span>
        <p>{brief.recommendation.reason}</p>
        <button onClick={() => onLesson(brief.recommendation.conceptId)}>
          Explore {brief.touched.find(concept => concept.id === brief.recommendation.conceptId)?.title ?? 'the recommended concept'} →
        </button>
      </div>
      <div className="actions repository-actions">
        <button className="primary-btn" onClick={() => onFollowUp(brief.conceptId)}>Ask about this change →</button>
      </div>
    </section>
  </>;
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
  return <article className="sheet" aria-label="Change brief">
    <span className="eyebrow">{reference(change)} · {depth} depth · {PROVIDER_LABELS[provider]}</span>
    {result.status === 'loading' && !fresh && <p role="status">Looking for a saved brief…</p>}
    {result.status === 'error' && !fresh && <div>
      <p role="alert">{result.message}</p><button onClick={refresh}>Retry saved brief</button>
    </div>}
    <SetupProvider provider={provider} onChange={choose} label="Brief provider" disabled={Boolean(generation.pending || generation.preview)} />
    {brief && <BriefContent brief={brief} saved={!fresh} onLesson={onLesson} onFollowUp={onFollowUp} />}
    {!brief && result.status === 'ready' && <p>Review the available diff to generate a change brief at this depth.</p>}
    <div className="actions repository-actions">
      <button disabled={Boolean(generation.pending || generation.preview)} onClick={() => void inspect()}>
        {brief ? 'Refresh diff preview' : 'Preview diff request'}
      </button>
    </div>
    <ProviderReview generation={generation} provider={provider} depth={depth} workflow="explain" />
  </article>;
}

function LiveChanges(props: Props) {
  const { selected, onSelect } = props;
  return <>
    <ReaderHeader {...props} label={props.workspace.name} title="Repository changes"
      summary="Review a commit or pull request and follow the concepts it touches." />
    <div className="reader reader-layout">
      {selected ? <ChangeReader key={selected.kind + '/' + selected.ref + '/' + props.depth} props={props} change={selected} />
        : <article className="sheet"><h2>Choose a change</h2><p>Select a commit or pull request to see its brief.</p></article>}
      <aside aria-label="Change list"><ChangeList workspaceId={props.workspace.id} selected={selected} onSelect={onSelect} /></aside>
    </div>
  </>;
}

export function Changes(props: Props) {
  if (props.graph.demo || props.workspace.kind === 'topic') return <DemoChanges {...props} />;
  return <LiveChanges {...props} />;
}
