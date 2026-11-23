import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type RefObject } from 'react';
import { DEFAULT_DEPTH, DEPTHS, type Depth, type ProviderId, type WorkspaceKind } from '../../shared/domain';
import type { TopicPreview } from '../../shared/reader';
import { call } from './api';
import { PROVIDER_LABELS } from './preferences';
import { SetupProvider, providerHint, useDetectedProvider, useProviderDetection } from './SetupProvider';
import { Terrain } from './Terrain';
import { errorMessage } from './useRead';
import { shouldFocusSource, type FocusWatch } from './sourceErrors';
import { droppedSource, repositoryInput } from './workspaceSource';
import { useAttachFiles, useAttachInventory, useAttachPreview } from './repository/AttachReads';
import { AttachReview } from './repository/AttachReview';
import { ExactRequest, PreviewMetadata } from './reader/TutorPreview';
import { useStartWorkspace, type WorkspaceAdded } from './useStartWorkspace';
import './setup.css';

interface Props {
  onAdded: WorkspaceAdded;
  onCancel?: () => void;
  onOpenSwitcher?: () => void;
  firstRun: boolean;
}

const DEPTH_LABELS = { high: 'High · Overview', medium: 'Medium · Mechanics', low: 'Low · Detail' } as const;

const SETUP_ERROR_ID = 'setup-error';

function SourceFields({ value, onValue, onPick, onDrop, invalid }: ReturnType<typeof useSourceFields> & { invalid: boolean }) {
  return <div className="formrow">
    <label htmlFor="source-input">Topic or repository</label>
    <div className="source-control" onDrop={onDrop} onDragOver={event => event.preventDefault()}>
      <input id="source-input" autoFocus required aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `source-hint ${SETUP_ERROR_ID}` : 'source-hint'} placeholder="Photography or https://github.com/owner/repo"
        value={value} maxLength={4096} onChange={event => onValue(event.target.value)} />
      <button type="button" onClick={onPick}>Choose folder…</button>
    </div>
    <span id="source-hint" className="sub">Paste or drop a GitHub URL, owner/name, or local repository path.</span>
  </div>;
}

function StartingDepth({ depth, onChange }: { depth: Depth; onChange: (depth: Depth) => void }) {
  return <fieldset className="formrow">
    <legend>Starting depth</legend>
    <div className="seg setup-segment">
      {DEPTHS.map(d => <button key={d} type="button" aria-pressed={depth === d} onClick={() => onChange(d)}>{DEPTH_LABELS[d]}</button>)}
    </div>
  </fieldset>;
}

function SetupArt({ onDemo }: { onDemo?: () => void }) {
  return <aside className="setup-art">
    <Terrain />
    {onDemo ? <><h2>Explore a sample atlas.</h2>
      <p>Learn about worker leases or photography with the offline tutor.</p>
      <button type="button" onClick={onDemo}>Explore demo atlas</button></>
      : <><h2>Your learning record</h2><p>Lessons, conversations and progress stay on this device. You choose what to share with your tutor.</p></>}
  </aside>;
}

function sourceKind(value: string): WorkspaceKind {
  const parsed = repositoryInput(value);
  if (parsed) return parsed.kind;
  if (/^(?:https?:\/\/|github\.com\/)/i.test(value.trim())) return 'github';
  if (/^(?:[\\/]|(?:\.{1,2}|~)[\\/]|[a-z]:[\\/])/i.test(value.trim())) return 'git';
  return 'topic';
}

function useSourceFields(actions: ReturnType<typeof useStartWorkspace>) {
  const [value, setValue] = useState('');
  const [asTopic, setAsTopic] = useState(false);
  const inferred = sourceKind(value);
  const kind = asTopic ? 'topic' : inferred;
  const repository = useMemo(() => kind === 'topic' ? undefined : repositoryInput(value), [kind, value]);
  function change(text: string, forceTopic = asTopic) {
    actions.clearError();
    setValue(text);
    setAsTopic(forceTopic);
  }

  return {
    value, kind, repository, inferred, asTopic, setAsTopic: (next: boolean) => change(value, next),
    onValue: change,
    onPick: () => void actions.run('pick', async () => {
      const path = await call('workspaces:pick-folder', null);
      if (path !== null) change(path, false);
    }),
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (actions.pending) return;
      const transfer = event.dataTransfer;
      const file = transfer.files[0];
      const path = file ? window.delve?.droppedPath?.(file) : undefined;
      const text = path || droppedSource(transfer.getData('text/uri-list'), transfer.getData('text/plain'));
      if (repositoryInput(text)) change(text, false);
      else actions.setError('Could not read that drop. Choose a folder, or paste an absolute path or GitHub repository URL.');
    },
  };
}

function useTopicPreview(title: string, depth: Depth, provider: ProviderId, enabled: boolean) {
  const [version, setVersion] = useState(0);
  const [settled, setSettled] = useState<{ key: string; data?: TopicPreview; error?: string }>();
  const key = enabled && title && title.length <= 120 ? JSON.stringify([title, depth, provider, version]) : '';
  useEffect(() => {
    if (!key) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void call('tutor:preview-topic', { title, depth, provider }).then(
        data => { if (current) setSettled({ key, data }); },
        cause => { if (current) setSettled({ key, error: errorMessage(cause) }); },
      );
    }, 130);
    return () => { current = false; window.clearTimeout(timer); };
  }, [key, title, depth, provider]);
  return {
    preview: settled?.key === key ? settled.data : undefined,
    error: settled?.key === key ? settled.error : undefined,
    pending: Boolean(key && settled?.key !== key),
    retry: () => setVersion(value => value + 1),
  };
}

function useAttachRequest(repository: ReturnType<typeof repositoryInput>, depth: Depth, provider: ProviderId, cli: ReturnType<typeof useDetectedProvider>['cli']) {
  const [permission, setPermission] = useState<{ token: string; allowed: boolean }>();
  const inventory = useAttachInventory(repository, cli);
  const snapshot = inventory.snapshot;
  const files = useAttachFiles(repository, snapshot?.inventory);
  const request = useAttachPreview(snapshot?.workspace.id, snapshot?.inventory.commit, files.selected, depth, provider, cli?.state === 'signed-in');
  const preview = request.preview;
  return {
    inventory, request, files, preview, allowed: Boolean(preview && permission?.token === preview.token && permission.allowed),
    chooseApproval: (allowed: boolean) => { if (preview) setPermission({ token: preview.token, allowed }); },
  };
}

function StartActions({ topic, signedIn, blocked, pending, attach, attachFailed, rememberTutor, onCancel, firstRun }: {
  topic: boolean; signedIn: boolean; blocked: boolean; pending: ReturnType<typeof useStartWorkspace>['pending'];
  attach: ReturnType<typeof useAttachRequest>; attachFailed: boolean; rememberTutor?: () => void;
  onCancel?: () => void; firstRun: boolean;
}) {
  return <div className="actions setup-actions">
    {attach.preview ? <>
      {attachFailed
        ? <button type="button" onClick={attach.request.retry}>Review request again</button>
        : <button className="primary-btn" type="submit" aria-describedby="attach-preview-summary">{pending === 'map' ? 'Adding…' : 'Add and build map'}</button>}
    </> : <button className="primary-btn" type="submit" disabled={blocked}
      aria-describedby={topic && signedIn ? 'topic-request-summary' : undefined}>
      {pending === 'add' ? 'Opening…' : topic ? signedIn ? 'Allow once and start lesson' : 'Start lesson →' : 'Add to atlas →'}
    </button>}
    {rememberTutor && <button type="button" disabled={blocked} onClick={rememberTutor}>Always allow for this workspace</button>}
    {onCancel && <button type="button" onClick={onCancel}>{firstRun ? 'Explore demo atlas' : 'Cancel'}</button>}
  </div>;
}

function SetupFeedback({ error, onOpenSwitcher }: { error: string; onOpenSwitcher: Props['onOpenSwitcher'] }) {
  if (!error) return null;
  return <div className="attach-feedback">
    <p role="alert" id={SETUP_ERROR_ID} className="setup-error">{error}</p>
    {error.includes('workspace switcher') && onOpenSwitcher
      ? <button type="button" onClick={onOpenSwitcher}>Open workspace switcher</button>
      : <button type="button" onClick={() => document.getElementById('source-input')?.focus()}>Edit source</button>}
  </div>;
}

function TopicReview({ provider, request }: { provider: ProviderId; request: ReturnType<typeof useTopicPreview> }) {
  const { preview, error, pending, retry } = request;
  return <div className="setup-topic-review" id="topic-request-summary" aria-live="polite">
    {pending && <p className="smallprint">Preparing the lesson request…</p>}
    {error && <div className="attach-feedback"><p role="alert">{error}</p><button type="button" onClick={retry}>Retry preview</button></div>}
    {preview && <>
      <p className="smallprint">Your tutor will receive this request. <PreviewMetadata provider={provider} data={preview} /></p>
      <p className="smallprint">Allow once to start this lesson, or allow future tutoring here with {PROVIDER_LABELS[provider]}.</p>
    </>}
  </div>;
}

/** Refocuses the rejected source unless the user moved focus (focusin, or a press outside the form) mid-request. */
function useSourceErrorFocus(form: RefObject<HTMLFormElement | null>, pending: boolean, rejected: boolean) {
  const watchRef = useRef<FocusWatch | null>(null);
  useLayoutEffect(() => {
    if (!pending) return;
    const watch: FocusWatch = { start: document.activeElement, moved: false };
    watchRef.current = watch;
    const focused = () => { watch.moved = true; };
    const pressed = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !form.current?.contains(event.target)) watch.moved = true;
    };
    document.addEventListener('focusin', focused, true);
    document.addEventListener('pointerdown', pressed, true);
    return () => {
      document.removeEventListener('focusin', focused, true);
      document.removeEventListener('pointerdown', pressed, true);
    };
  }, [form, pending]);
  useEffect(() => {
    if (!rejected) return;
    const source = document.getElementById('source-input');
    const settled = watchRef.current;
    watchRef.current = null;
    if (shouldFocusSource(settled, document.activeElement, document.body, source)) source?.focus();
  }, [rejected]);
}

function WorkspaceEditor(props: Props) {
  const [depth, setDepth] = useState<Depth>(DEFAULT_DEPTH);
  const detection = useProviderDetection();
  const { provider, choose, cli } = useDetectedProvider(detection.statuses);
  const actions = useStartWorkspace(props.onAdded, depth, provider);
  const form = useRef<HTMLFormElement>(null);
  useSourceErrorFocus(form, actions.pending !== null, actions.sourceError && !actions.pending);
  const source = useSourceFields(actions);
  const attach = useAttachRequest(source.repository, depth, provider, cli);
  const topic = source.kind === 'topic';
  const signedIn = topic && cli?.state === 'signed-in';
  const title = source.value.trim().replace(/\s+/g, ' ');
  const request = useTopicPreview(title, depth, provider, signedIn);
  const waitingForTopic = Boolean(signedIn && title && title.length <= 120 && !request.preview);
  const waitingForMap = attach.inventory.pending || attach.request.pending;
  const blocked = !title || detection.checking || waitingForTopic || waitingForMap;
  const showFiles = Boolean(source.repository && cli?.state === 'signed-in');
  const preview = attach.preview;
  const attachFailed = Boolean(preview && actions.failedToken === preview.token);

  const addOnly = () => actions.addOnly(source.kind, source.value, request.preview);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked || attachFailed) return;
    if (preview) actions.buildMap(preview, attach.allowed);
    else addOnly();
  }

  return <form ref={form} className="setup-grid" aria-label="Add workspace" onSubmit={submit}>
    <fieldset className="sheet setup-form" disabled={actions.pending !== null}>
      <SourceFields {...source} invalid={actions.sourceError} />
      <p className="smallprint setup-cli-status" role="status">{detection.error ? 'Could not check sign-in. Open Advanced options to retry.' :
        cli ? providerHint(cli) : 'Checking installed CLIs…'}</p>
      <details className="setup-advanced">
        <summary>Advanced options <span className="smallprint">· {DEPTH_LABELS[depth].split(' · ')[0]} · {PROVIDER_LABELS[provider]}</span></summary>
        {source.inferred !== 'topic' && <label><input type="checkbox" checked={source.asTopic}
          onChange={event => source.setAsTopic(event.target.checked)} /> Treat input as a topic</label>}
        <StartingDepth depth={depth} onChange={next => { actions.clearError(); setDepth(next); }} />
        <SetupProvider label="Tutor" provider={provider} detection={detection}
          onChange={next => { actions.clearError(); choose(next); }} />
        {showFiles && <button type="button" onClick={addOnly}>Add without mapping</button>}
      </details>
      {signedIn && <TopicReview provider={provider} request={request} />}
      <SetupFeedback error={actions.error} onOpenSwitcher={props.onOpenSwitcher} />
      <StartActions topic={topic} signedIn={Boolean(request.preview)} blocked={blocked}
        pending={actions.pending} attach={attach} attachFailed={attachFailed}
        rememberTutor={request.preview ? () => actions.addOnly(source.kind, source.value, request.preview, true) : undefined}
        onCancel={props.firstRun && !showFiles ? undefined : props.onCancel} firstRun={props.firstRun} />
      {request.preview && <ExactRequest data={request.preview} />}
    </fieldset>
    {showFiles ? <fieldset className="sheet setup-form setup-source-review" disabled={actions.pending !== null}>
      <AttachReview inventory={attach.inventory} request={attach.request} depth={depth} provider={provider}
        selected={attach.files.selected} onFiles={paths => { actions.clearError(); attach.files.select(paths); }}
        allowed={attach.allowed} onAlwaysAllow={attach.chooseApproval} />
    </fieldset> : <SetupArt onDemo={props.firstRun ? props.onCancel : undefined} />}
  </form>;
}

export function AddWorkspaceForm(props: Props) {
  return <>
    <div className="intro">
      <h1>What will you explore?</h1>
      <p>Start with a topic or a repository. You can change the depth while you learn.</p>
    </div>
    <WorkspaceEditor {...props} />
  </>;
}
