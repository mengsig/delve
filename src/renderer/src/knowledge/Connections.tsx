import { useEffect, useRef, useState } from 'react';
import type { ConnectionPreview, KnowledgeConcept } from '../../../shared/knowledge';
import type { ProviderId } from '../../../shared/domain';
import { call } from '../api';
import { errorMessage } from '../useRead';

export function Connections({ concept, refresh }: { concept: KnowledgeConcept; refresh: () => void }) {
  const [provider, setProvider] = useState<ProviderId>('claude');
  const [preview, setPreview] = useState<ConnectionPreview>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => () => { void call('connections:cancel', null).catch(error => console.error('Could not clear connection preview', error)); }, [concept.id]);
  async function prepare() {
    setBusy(true); setMessage('');
    try { setPreview(await call('connections:preview', { provider, conceptId: concept.id })); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function run() {
    if (!preview) return;
    setBusy(true); setMessage('');
    try { const result = await call('connections:run', { token: preview.token, consent: true }); setPreview(undefined);
      setMessage(result.suggestions.length ? `Added ${result.suggestions.length} connections.` : 'No connections were suggested.'); refresh(); }
    catch (error) { setMessage(errorMessage(error)); setPreview(undefined); }
    finally { setBusy(false); }
  }
  function close() { setPreview(undefined); void call('connections:cancel', null).catch(error => setMessage(errorMessage(error))); }
  return <div className="knowledge-connections"><h3>Find connections</h3><p>Ask your tutor to compare this concept with up to 40 other ideas in your graph.</p>
    <label>Provider <select value={provider} onChange={e => setProvider(e.target.value as ProviderId)}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>{' '}
    <button disabled={busy} onClick={() => void prepare()}>Preview request</button>
    {message && <p role="status">{message}</p>}
    {preview && <ConnectionDialog preview={preview} busy={busy} run={() => void run()} close={close} />}
  </div>;
}
function ConnectionDialog({ preview, busy, run, close }: { preview: ConnectionPreview; busy: boolean; run: () => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} aria-labelledby="connection-preview-title" className="knowledge-preview" onCancel={event => { event.preventDefault(); close(); }}>
      <h2 id="connection-preview-title">Review what will be sent</h2><p>{preview.provider} · {preview.model ?? 'provider default model'} · {preview.bytes.toLocaleString()} bytes · No files attached</p>
      <p>The tutor may suggest links. You can remove any link afterwards.</p><details open><summary>Exact request</summary><pre>{preview.prompt}</pre></details>
      <details><summary>Response format sent to the provider</summary><pre>{preview.outputSchema}</pre></details>
      <button className="primary-btn" disabled={busy} onClick={run}>Allow once and find connections</button> <button onClick={close}>{busy ? 'Cancel request' : 'Cancel'}</button>
    </dialog>;
}
