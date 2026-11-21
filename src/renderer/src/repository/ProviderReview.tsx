import { useEffect, useId, useRef, useState } from 'react';
import type { Depth, ProviderId } from '../../../shared/domain';
import { PROVIDER_LABELS } from '../preferences';
import { errorMessage } from '../useRead';
import type { useRepositoryGeneration } from './useRepositoryGeneration';
import './repository.css';

interface Props {
  generation: ReturnType<typeof useRepositoryGeneration>;
  provider: ProviderId;
  depth: Depth;
  workflow: 'map' | 'explain';
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

export function ProviderReview({ generation, provider, depth, workflow, disabled }: Props) {
  const { preview, pending, error, approve, close } = generation;
  const title = useId();
  const mapping = workflow === 'map';
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (preview) heading.current?.focus(); }, [preview]);
  return <>
    {pending && <p role="status">Preparing provider request…</p>}
    {error && <div><p className="setup-error" role="alert">{error.message}</p>
      <CopyGitHubLogin message={error.message} /></div>}
    {preview && <section className="repository-review" aria-labelledby={title}>
      <h3 id={title} ref={heading} tabIndex={-1}>Review provider request</h3>
      <p>{PROVIDER_LABELS[provider]} · {preview.model} · {depth} depth · {preview.bytes.toLocaleString()} bytes</p>
      <p className="repository-ref"><strong>{preview.title}</strong> · <code>{preview.commit}</code></p>
      {preview.partial && <p className="repository-notice" role="status">Partial coverage. {preview.coverageNote ?? 'The provider request uses only the available content shown here.'}</p>}
      {preview.files.length > 0 && <p>Files included: {preview.files.join(', ')}</p>}
      <details open><summary>Exact request</summary><pre aria-label="Exact provider request" tabIndex={0}>{preview.prompt}</pre></details>
      <div className="actions">
        <button className="primary-btn" disabled={disabled} onClick={approve}>{mapping ? 'Approve and map' : 'Approve and explain'}</button>
        <button onClick={close}>Dismiss preview</button>
      </div>
    </section>}
  </>;
}
