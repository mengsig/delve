import { modelLabel } from '../modelLabel';
import { useEffect, useId, useRef, useState } from 'react';
import type { Depth, ProviderId } from '../../../shared/domain';
import type { RepoPreview } from '../../../shared/repository';
import { PROVIDER_LABELS } from '../preferences';
import { errorMessage } from '../useRead';
import { AlwaysAllowSource } from './SourceApproval';
import type { useRepositoryApproval } from './repositoryApproval';
import type { useRepositoryGeneration } from './useRepositoryGeneration';
import './repository.css';

interface Props {
  generation: ReturnType<typeof useRepositoryGeneration>;
  provider: ProviderId;
  depth: Depth;
  approval: ReturnType<typeof useRepositoryApproval>;
  disabled?: boolean;
}

export function CopyGitHubLogin({ message }: { message: string }) {
  const [result, setResult] = useState<{ status: 'copied' | 'error'; message: string }>();
  if (!message.includes('gh auth login')) return null;
  async function copyCommand() {
    try {
      await navigator.clipboard.writeText('gh auth login');
      setResult({ status: 'copied', message: 'Copied gh auth login.' });
    } catch (cause) {
      setResult({ status: 'error', message: 'Could not copy the command. ' + errorMessage(cause) });
    }
  }
  return <>
    <button type="button" onClick={() => void copyCommand()}>Copy gh auth login</button>
    {result && <span role={result.status === 'error' ? 'alert' : 'status'}>{result.message}</span>}
  </>;
}

function MapPermission({ preview, generation, approval, provider, disabled }: Pick<Props, 'generation' | 'approval' | 'provider' | 'disabled'> & {
  preview: RepoPreview;
}) {
  const [allowed, setAllowed] = useState(false);
  return <>
    <p>“Approve and map” sends the source shown above to {PROVIDER_LABELS[provider]}.</p>
    {!approval.allowed && <AlwaysAllowSource provider={provider} category="map" checked={allowed} onChange={setAllowed} />}
    <div className="actions">
      <button className="primary-btn" disabled={disabled} onClick={() => generation.approve(preview, allowed ? () => approval.setAllowed(true) : undefined)}>
        Approve and map
      </button>
      <button onClick={generation.close}>Dismiss preview</button>
    </div>
  </>;
}

export function ProviderReview({ generation, provider, depth, approval, disabled }: Props) {
  const { preview, pending, error } = generation;
  const title = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (preview) heading.current?.focus(); }, [preview]);
  return <>
    {pending && <p role="status">Preparing provider request…</p>}
    {error && <div><p className="setup-error" role="alert">{error.message}</p>
      <CopyGitHubLogin message={error.message} /></div>}
    {preview && <section className="repository-review" aria-labelledby={title}>
      <h3 id={title} ref={heading} tabIndex={-1}>Review provider request</h3>
      <RepositoryRequestSource preview={preview} provider={provider} depth={depth} expanded />
      <MapPermission key={preview.token} preview={preview} generation={generation} approval={approval} provider={provider} disabled={disabled} />
    </section>}
  </>;
}

export function RepositoryRequestSource({ preview, provider, depth, expanded, inlinePrompt }: {
  preview: RepoPreview; provider: ProviderId; depth: Depth; expanded?: boolean; inlinePrompt?: boolean;
}) {
  const exact = <pre aria-label="Exact provider request" tabIndex={0}>{preview.prompt}</pre>;
  return <>
    <p>{PROVIDER_LABELS[provider]} · {modelLabel(provider, preview)} · {depth} depth · {preview.bytes.toLocaleString()} bytes</p>
    <p className="repository-ref"><strong>{preview.title}</strong> · <code>{preview.commit}</code></p>
    {preview.partial && <p className="repository-notice" role="status">Partial coverage. {preview.coverageNote ?? 'The provider request uses only the available content shown here.'}</p>}
    {preview.files.length > 0 && <p>Files included: {preview.files.join(', ')}</p>}
    {inlinePrompt ? exact : <details open={expanded}><summary>Exact request</summary>{exact}</details>}
  </>;
}
