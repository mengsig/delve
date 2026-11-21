import { useEffect, useRef } from 'react';
import type { Depth, ProviderId } from '../../../shared/domain';
import { PROVIDER_LABELS } from '../preferences';
import type { useRepositoryGeneration } from './useRepositoryGeneration';
import './repository.css';

interface Props {
  generation: ReturnType<typeof useRepositoryGeneration>;
  provider: ProviderId;
  depth: Depth;
  workflow: 'map' | 'explain';
}

export function ProviderReview({ generation, provider, depth, workflow }: Props) {
  const { preview, pending, error, approve, cancel, close } = generation;
  const mapping = workflow === 'map';
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (preview) heading.current?.focus(); }, [preview]);
  return <>
    {pending === 'preview' && <p role="status">Preparing provider request…</p>}
    {pending === 'generate' && <div className="actions">
      <span role="status">{PROVIDER_LABELS[provider]} is preparing your {mapping ? 'atlas' : 'brief'}…</span>
      <button onClick={() => void cancel()}>Cancel generation</button>
    </div>}
    {error && <p className="setup-error" role="alert">{error}</p>}
    {preview && <section className="repository-review" aria-labelledby="repo-request-title">
      <h3 id="repo-request-title" ref={heading} tabIndex={-1}>Review provider request</h3>
      <p>{PROVIDER_LABELS[provider]} · {preview.model} · {depth} depth · {preview.bytes.toLocaleString()} bytes</p>
      <p className="repository-ref"><strong>{preview.title}</strong> · <code>{preview.commit}</code></p>
      {preview.partial && <p className="repository-notice" role="status">Partial coverage. {preview.coverageNote ?? 'The provider request uses only the available content shown here.'}</p>}
      {preview.files.length > 0 && <p>Files included: {preview.files.join(', ')}</p>}
      <details open><summary>Exact request</summary><pre aria-label="Exact provider request" tabIndex={0}>{preview.prompt}</pre></details>
      <div className="actions">
        <button className="primary-btn" onClick={() => void approve()}>{mapping ? 'Approve and map' : 'Approve and explain'}</button>
        <button onClick={close}>Dismiss preview</button>
      </div>
    </section>}
  </>;
}
