import { useEffect, useRef } from 'react';
import type { TopicPreview, TutorRequest } from '../../../shared/reader';
import { modelLabel } from '../modelLabel';
import { PROVIDER_LABELS } from '../preferences';

type Provider = TutorRequest['provider'];

export function PreviewMetadata({ provider, data }: { provider: Provider; data: TopicPreview }) {
  return <>{provider === 'demo' ? 'Demo tutor' : PROVIDER_LABELS[provider]} · {modelLabel(provider, data)} · {' '}
    {data.bytes.toLocaleString()} bytes · {data.files.length ? data.files.join(', ') : 'No files attached'}</>;
}

export function ExactRequest({ data, expanded }: { data: TopicPreview; expanded?: boolean }) {
  return <details className="exact-tutor-request" open={expanded}>
    <summary>Exact request</summary>
    <pre aria-label="Exact provider request" tabIndex={0}>{data.prompt}</pre>
  </details>;
}

export function TutorPreviewDialog({ data, request, exact, approve, close, error }: {
  data: TopicPreview; request: TutorRequest; exact: boolean; approve: (always: boolean) => void; close: () => void; error: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const { provider } = request;
  const offline = provider === 'demo';
  return <dialog ref={dialog} className="reader-preview" aria-labelledby="preview-title" onCancel={close}>
    <h3 id="preview-title">{offline ? 'Review local tutor input' : 'Review what will be sent'}</h3>
    <p><PreviewMetadata provider={provider} data={data} /></p>
    <ExactRequest data={data} expanded={exact} />
    {!offline && <p className="smallprint">Allow this request once, or allow future tutoring in this workspace with {PROVIDER_LABELS[provider]}.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="actions">
      <button className="primary-btn" onClick={() => approve(false)}>{offline ? 'Continue' : 'Allow once and continue'}</button>
      {!offline && <button onClick={() => approve(true)}>Always allow for this workspace</button>}
      <button onClick={close}>Close preview</button>
    </div>
  </dialog>;
}

export function TutorConsent({ data, request, approve, close, error }: {
  data: TopicPreview; request: TutorRequest; approve: (always: boolean) => void; close: () => void; error: string;
}) {
  return <section className="inline-consent" aria-label="Review what will be sent">
    <h3>Review what will be sent</h3><p><PreviewMetadata provider={request.provider} data={data} /></p>
    <ExactRequest data={data} />
    {error && <p role="alert">{error}</p>}
    <div className="actions"><button className="primary-btn" onClick={() => approve(false)}>Allow once and continue</button>
      <button onClick={() => approve(true)}>Always allow for this workspace</button>
      <button onClick={close}>Close preview</button>
    </div>
  </section>;
}
