import { useEffect, useRef, useState } from 'react';
import type { ProviderStatus } from '../../../shared/domain';
import type { LessonAddress, ReaderLesson, TutorIntent, TutorPreview, TutorRequest } from '../../../shared/reader';
import { call } from '../api';
import { preferredProvider } from '../preferences';
import { errorMessage } from '../useRead';

type Provider = TutorRequest['provider'];
interface Preview { request: TutorRequest; data: TutorPreview }
const consent = new Set<string>();
const consentKey = (request: TutorRequest) => request.workspaceId + '/' + request.provider;

function useProviderStatuses(demo: boolean) {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    if (!demo) call('providers:detect', null).then(
      value => { if (current) setStatuses(value); },
      failure => { if (current) setError(errorMessage(failure)); },
    );
    return () => { current = false; };
  }, [demo]);
  return { statuses, error };
}

function useGeneration(onLesson: (lesson: ReaderLesson, intent: TutorIntent) => void) {
  const active = useRef<{ id: string; running: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview>();
  useEffect(() => () => {
    const last = active.current;
    active.current = null;
    if (last?.running) void call('tutor:cancel', { requestId: last.id }).catch(e => console.error('Tutor cancellation failed', e));
  }, []);
  async function start(request: TutorRequest, inspect: boolean, approved?: TutorPreview) {
    if (active.current) return;
    const attempt = { id: crypto.randomUUID(), running: false };
    active.current = attempt;
    setPreview(undefined);
    setError('');
    setPending(true);
    try {
      const data = approved ?? await call('tutor:preview', request);
      if (active.current !== attempt) return;
      if (inspect || (request.provider !== 'demo' && !approved && !consent.has(consentKey(request)))) {
        setPreview({ request, data });
        return;
      }
      attempt.running = true;
      const lesson = await call('tutor:run', { ...request, token: data.token, requestId: attempt.id });
      if (active.current === attempt) {
        if (approved) consent.add(consentKey(request));
        onLesson(lesson, request.intent);
      }
    } catch (failure) {
      if (active.current === attempt) setError(errorMessage(failure));
    } finally {
      if (active.current === attempt) { active.current = null; setPending(false); }
    }
  }
  async function cancel() {
    const attempt = active.current;
    if (!attempt) return;
    if (attempt.running) {
      try { await call('tutor:cancel', { requestId: attempt.id }); }
      catch (failure) { if (active.current === attempt) setError(errorMessage(failure)); }
    } else {
      active.current = null;
      setPending(false);
      setError('The request preview was cancelled.');
    }
  }
  return { pending, error, preview, setPreview, start, cancel };
}

export function useTutor(address: LessonAddress, demo: boolean, onLesson: (lesson: ReaderLesson, intent: TutorIntent) => void) {
  const [provider, choose] = useState<Provider>(demo ? 'demo' : preferredProvider());
  const [lastIntent, setLastIntent] = useState<TutorIntent>();
  const generation = useGeneration(onLesson);
  const detection = useProviderStatuses(demo);
  function prepare(intent: TutorIntent, inspect = false) {
    setLastIntent(intent);
    return generation.start({ ...address, provider, intent }, inspect);
  }
  return { ...generation, detection, provider, prepare, lastIntent, choose,
    approve: () => generation.preview && generation.start(generation.preview.request, false, generation.preview.data) };
}

function RequestPreview({ preview, approve, close }: { preview: Preview; approve: () => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const { data, request } = preview;
  const offline = request.provider === 'demo';
  const model = offline ? data.model : data.modelSource === 'codex-config' ? `${data.model} · from Codex config` :
    data.model === null ? `${request.provider === 'codex' ? 'Codex' : 'Claude'} default` : `Requested model: ${data.model}`;
  return <dialog ref={dialog} className="reader-preview" aria-labelledby="preview-title" onCancel={close}>
    <span className="eyebrow">Provider request / {request.provider}</span>
    <h3 id="preview-title">{offline ? 'Review local tutor input' : 'Review what will be sent'}</h3>
    <p>{model} · {data.bytes.toLocaleString()} bytes · {data.files.length ? data.files.join(', ') : 'No files attached'}</p>
    <pre tabIndex={0}>{data.prompt}</pre>
    <p className="smallprint">{offline ? 'This tutor runs locally.' :
      'Allow Delve to share this prompt and subsequent turns with this provider in this workspace for this session.'}</p>
    <div className="actions"><button className="primary-btn" onClick={approve}>{offline ? 'Continue' : 'Allow and continue'}</button>
      <button onClick={close}>Close preview</button></div>
  </dialog>;
}

export function TutorControls({ tutor, demo, canStart }: { tutor: ReturnType<typeof useTutor>; demo: boolean; canStart: boolean }) {
  const { provider, choose, detection, pending, preview, setPreview, prepare, approve } = tutor;
  const status = detection.statuses.find(s => s.id === provider);
  return <>
    {!demo && <div className="reader-provider">
      <label htmlFor="tutor-provider">Tutor</label>
      <select id="tutor-provider" value={provider} disabled={pending} onChange={event => choose(event.target.value as Provider)}>
        <option value="codex">Codex</option><option value="claude">Claude Code</option>
      </select>
      <span className="smallprint" role="status">{detection.error || status?.detail || 'Checking sign-in…'}</span>
    </div>}
    {canStart && <button className="primary-btn" disabled={pending} onClick={() => void prepare({ kind: 'teach' })}>Start lesson</button>}
    {preview && <RequestPreview preview={preview} approve={approve} close={() => setPreview(undefined)} />}
  </>;
}
