import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { DEFAULT_DEPTH, DEPTHS, type Depth, type ProviderId, type Workspace, type WorkspaceKind } from '../../shared/domain';
import type { RepoPreview } from '../../shared/repository';
import type { TopicPreview, TutorRequest } from '../../shared/reader';
import { call, IpcCallError } from './api';
import { PROVIDER_LABELS } from './preferences';
import { SetupProvider, providerHint, useDetectedProvider, useProviderDetection } from './SetupProvider';
import { Terrain } from './Terrain';
import { errorMessage } from './useRead';
import { droppedSource, repositoryInput, workspaceInput } from './workspaceSource';
import { useAttachFiles, useAttachInventory, useAttachPreview } from './repository/AttachReads';
import { AttachReview } from './repository/AttachReview';
import { useMapJobs } from './repository/MapJobs';
import { setRepositoryApproval } from './repository/repositoryApproval';
import { useTutorJobs } from './reader/TutorJobs';
import { ExactRequest, PreviewMetadata } from './reader/TutorPreview';
import './setup.css';

interface Props {
  onAdded: (workspace: Workspace, depth: Depth, conceptId?: number) => void;
  onCancel?: () => void;
  onOpenSwitcher?: () => void;
  firstRun: boolean;
}

const DEPTH_LABELS = { high: 'High · Overview', medium: 'Medium · Mechanics', low: 'Low · Detail' } as const;

function SourceFields({ value, onValue, onPick, onDrop }: ReturnType<typeof useSourceFields>) {
  return <div className="formrow">
    <label htmlFor="source-input">Topic or repository</label>
    <div className="source-control" onDrop={onDrop} onDragOver={event => event.preventDefault()}>
      <input id="source-input" autoFocus aria-describedby="source-hint" required placeholder="Photography or https://github.com/owner/repo"
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

function SetupArt() {
  return <aside className="setup-art">
    <Terrain />
    <p>Your learning evidence stays on this device.</p>
  </aside>;
}

function addError(cause: unknown, action: string) {
  const message = errorMessage(cause);
  if (cause instanceof IpcCallError && cause.code === 'DUPLICATE_WORKSPACE') {
    return message + ' Open it from the workspace switcher.';
  }
  if (action === 'pick') return 'Could not choose a folder. ' + message;
  return (action === 'map' ? 'Could not attach the reviewed map request. ' : 'Could not add the workspace. ') + message;
}

function useWorkspaceActions() {
  const locked = useRef(false);
  const [pending, setPending] = useState<'pick' | 'add' | 'map' | null>(null);
  const [error, setError] = useState('');
  const [failedToken, setFailedToken] = useState<string>();

  async function run(action: NonNullable<typeof pending>, apply: () => Promise<void>, preview?: RepoPreview) {
    if (locked.current) return;
    locked.current = true;
    setPending(action);
    setError('');
    try {
      await apply();
    } catch (cause) {
      setError(addError(cause, action));
      if (preview) setFailedToken(preview.token);
    } finally {
      setPending(null);
      locked.current = false;
    }
  }

  return { pending, error, failedToken, setError, run, clearError: () => setError('') };
}

function sourceKind(value: string): WorkspaceKind {
  const parsed = repositoryInput(value);
  if (parsed) return parsed.kind;
  if (/^(?:https?:\/\/|github\.com\/)/i.test(value.trim())) return 'github';
  if (/^(?:[\\/]|(?:\.{1,2}|~)[\\/]|[a-z]:[\\/])/i.test(value.trim())) return 'git';
  return 'topic';
}

function useSourceFields(actions: ReturnType<typeof useWorkspaceActions>) {
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

function StartActions({ topic, signedIn, blocked, pending, attach, attachFailed, addOnly, onCancel, firstRun }: {
  topic: boolean; signedIn: boolean; blocked: boolean; pending: ReturnType<typeof useWorkspaceActions>['pending'];
  attach: ReturnType<typeof useAttachRequest>; attachFailed: boolean; addOnly: () => void;
  onCancel?: () => void; firstRun: boolean;
}) {
  return <div className="actions setup-actions">
    {attach.preview ? <>
      {attachFailed
        ? <button type="button" onClick={attach.request.retry}>Review request again</button>
        : <button className="primary-btn" type="submit" aria-describedby="attach-preview-summary">{pending === 'map' ? 'Adding…' : 'Add and build map'}</button>}
      <button type="button" onClick={addOnly}>{pending === 'add' ? 'Adding…' : 'Add without mapping'}</button>
    </> : <button className="primary-btn" type="submit" disabled={blocked}
      aria-describedby={topic && signedIn ? 'topic-request-summary' : undefined}>
      {pending === 'add' ? 'Opening…' : topic ? signedIn ? 'Allow once and start lesson' : 'Start lesson →' : 'Add to atlas →'}
    </button>}
    {onCancel && <button type="button" onClick={onCancel}>{firstRun ? 'Explore demo atlas' : 'Cancel'}</button>}
  </div>;
}

function sameRequest(reviewed: TopicPreview, current: TopicPreview) {
  return reviewed.prompt === current.prompt && reviewed.bytes === current.bytes && reviewed.model === current.model
    && reviewed.modelSource === current.modelSource && reviewed.files.length === current.files.length
    && reviewed.files.every((file, index) => file === current.files[index]);
}

function useStartWorkspace(props: Props, depth: Depth, provider: ProviderId) {
  const actions = useWorkspaceActions();
  const incompleteTopic = useRef<Workspace | null>(null);
  const { start: map } = useMapJobs();
  const { start: teach, reportFailure } = useTutorJobs();

  function addOnly(kind: WorkspaceKind, value: string, reviewed?: TopicPreview) {
    void actions.run('add', async () => {
      const input = workspaceInput(kind, value);
      if (input.kind !== 'topic') return props.onAdded(await call('workspaces:add', input), depth);
      const saved = incompleteTopic.current;
      const workspace = saved?.name === input.title ? saved : await call('workspaces:add', input);
      incompleteTopic.current = workspace;
      const conceptId = await call('reader:start-topic', { workspaceId: workspace.id });
      incompleteTopic.current = null;
      if (reviewed) {
        const request: TutorRequest = { workspaceId: workspace.id, conceptId, depth, provider, intent: { kind: 'teach' } };
        try {
          const current = await call('tutor:preview', request);
          if (!sameRequest(reviewed, current)) throw new IpcCallError('STALE_PREVIEW', 'The tutor request changed. Review the current request and retry.');
          if (!teach({ request, token: current.token, title: workspace.name })) throw new Error('This lesson is already being prepared.');
        } catch (cause) {
          reportFailure(request, workspace.name, cause);
        }
      }
      props.onAdded(workspace, depth, conceptId);
    });
  }

  function buildMap(preview: RepoPreview, allowed: boolean) {
    void actions.run('map', async () => {
      const workspace = await call('repo:attach', { token: preview.token });
      map({ workspace, depth, provider, preview });
      if (allowed) {
        try { setRepositoryApproval(workspace.id, provider, 'map', true); }
        catch (cause) { window.alert('The workspace was added. Could not save map approval. ' + errorMessage(cause)); }
      }
      props.onAdded(workspace, depth);
    }, preview);
  }
  return { ...actions, addOnly, buildMap };
}

function SetupFeedback({ error, onOpenSwitcher }: { error: string; onOpenSwitcher: Props['onOpenSwitcher'] }) {
  if (!error) return null;
  return <div className="attach-feedback">
    <p role="alert" className="setup-error">{error}</p>
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
      <p className="smallprint">The lesson request uses your signed-in CLI. <PreviewMetadata provider={provider} data={preview} /></p>
      <ExactRequest data={preview} />
    </>}
  </div>;
}

function WorkspaceEditor(props: Props) {
  const [depth, setDepth] = useState<Depth>(DEFAULT_DEPTH);
  const detection = useProviderDetection();
  const { provider, choose, cli } = useDetectedProvider(detection.statuses);
  const actions = useStartWorkspace(props, depth, provider);
  const source = useSourceFields(actions);
  const attach = useAttachRequest(source.repository, depth, provider, cli);
  const topic = source.kind === 'topic';
  const signedIn = topic && cli?.state === 'signed-in';
  const title = source.value.trim().replace(/\s+/g, ' ');
  const request = useTopicPreview(title, depth, provider, signedIn);
  const blocked = Boolean(topic && title && (detection.checking || (signedIn && title.length <= 120 && !request.preview)));
  const preview = attach.preview;
  const attachFailed = Boolean(preview && actions.failedToken === preview.token);

  const addOnly = () => actions.addOnly(source.kind, source.value, request.preview);
  function buildMap() {
    if (preview && !attachFailed) actions.buildMap(preview, attach.allowed);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (preview) buildMap();
    else if (!blocked) addOnly();
  }

  return <form className="sheet setup-form" aria-label="Add workspace" onSubmit={submit}>
    <fieldset className="setup-controls" disabled={actions.pending !== null}>
      <SourceFields {...source} />
      <p className="smallprint setup-cli-status" role="status">{detection.error ? 'Could not check sign-in. Open Advanced options to retry.' :
        cli ? providerHint(cli) : 'Checking installed CLIs…'}</p>
      <details className="setup-advanced">
        <summary>Advanced options <span className="smallprint">· {DEPTH_LABELS[depth].split(' · ')[0]} · {PROVIDER_LABELS[provider]}</span></summary>
        {source.inferred !== 'topic' && <label><input type="checkbox" checked={source.asTopic}
          onChange={event => source.setAsTopic(event.target.checked)} /> Treat input as a topic</label>}
        <StartingDepth depth={depth} onChange={next => { actions.clearError(); setDepth(next); }} />
        <SetupProvider label="Tutor CLI" provider={provider} detection={detection}
          onChange={next => { actions.clearError(); choose(next); }} />
      </details>
      {signedIn && <TopicReview provider={provider} request={request} />}
      {!topic && <AttachReview inventory={attach.inventory} request={attach.request} depth={depth} provider={provider}
        selected={attach.files.selected} onFiles={paths => { actions.clearError(); attach.files.select(paths); }}
        allowed={attach.allowed} onAlwaysAllow={attach.chooseApproval} />}
      <SetupFeedback error={actions.error} onOpenSwitcher={props.onOpenSwitcher} />
      <StartActions topic={topic} signedIn={signedIn} blocked={blocked}
        pending={actions.pending} attach={attach} attachFailed={attachFailed} addOnly={addOnly}
        onCancel={props.onCancel} firstRun={props.firstRun} />
    </fieldset>
  </form>;
}

export function AddWorkspaceForm(props: Props) {
  return <>
    <div className="intro">
      <h1>What will you explore?</h1>
      <p>Start with a topic or a repository. You can change the depth while you learn.</p>
    </div>
    <div className="setup-grid">
      <WorkspaceEditor {...props} />
      <SetupArt />
    </div>
  </>;
}
