import { useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { DEFAULT_DEPTH, DEPTHS, type Depth, type ProviderId, type Workspace, type WorkspaceKind } from '../../shared/domain';
import { call, IpcCallError } from './api';
import { preferredProvider } from './preferences';
import { SetupProvider, useProviderDetection } from './SetupProvider';
import { Terrain } from './Terrain';
import { errorMessage } from './useRead';
import { droppedSource, repositoryInput, workspaceInput } from './workspaceSource';
import { useAttachFiles, useAttachInventory, useAttachPreview } from './repository/AttachReads';
import { AttachReview } from './repository/AttachReview';
import { useMapJobs } from './repository/MapJobs';
import type { RepoPreview } from '../../shared/repository';
import './setup.css';

interface Props {
  onAdded: (workspace: Workspace, depth: Depth) => void;
  onCancel?: () => void;
  onOpenSwitcher?: () => void;
  firstRun: boolean;
}

const SOURCES = {
  github: { label: 'GitHub URL', example: 'https://github.com/owner/repository', hint: 'Paste or drop a GitHub URL, owner/name, or absolute folder path.' },
  git: { label: 'Local folder', example: '/path/to/repository', hint: 'Paste or drop an absolute folder path, GitHub URL, or owner/name.' },
  topic: { label: 'Any topic', example: 'e.g. Photography', hint: 'Any subject can have an atlas and its own instruments.' },
} as const;
const DEPTH_LABELS = { high: 'High · Overview', medium: 'Medium · Mechanics', low: 'Low · Detail' } as const;

interface SourceProps {
  kind: WorkspaceKind;
  value: string;
  onKind: (kind: WorkspaceKind) => void;
  onValue: (value: string) => void;
  onPick: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
}

function SourceFields({ kind, value, onKind, onValue, onPick, onDrop }: SourceProps) {
  const { label, example, hint } = SOURCES[kind];
  return (
    <>
      <fieldset className="formrow">
        <legend>01 &nbsp; Choose a source</legend>
        <div className="seg setup-segment">
          {(['github', 'git', 'topic'] as const).map((source) => (
            <button key={source} type="button" aria-pressed={source === kind} onClick={() => onKind(source)}>
              {SOURCES[source].label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="formrow">
        <label htmlFor="source-input">{label}</label>
        <div className="source-control" onDrop={kind === 'topic' ? undefined : onDrop}
          onDragOver={kind === 'topic' ? undefined : event => event.preventDefault()}>
          <input id="source-input" aria-describedby="source-hint" required placeholder={example} value={value}
            maxLength={4096} onChange={(event) => onValue(event.target.value)} />
          {kind !== 'topic' && <button type="button" onClick={onPick}>Choose folder…</button>}
        </div>
        <span id="source-hint" className="sub">{hint}</span>
      </div>
    </>
  );
}

function StartingDepth({ depth, onChange }: { depth: Depth; onChange: (depth: Depth) => void }) {
  return (
    <fieldset className="formrow">
      <legend>02 &nbsp; Starting depth</legend>
      <div className="seg setup-segment">
        {DEPTHS.map((d) => <button key={d} type="button" aria-pressed={depth === d} onClick={() => onChange(d)}>{DEPTH_LABELS[d]}</button>)}
      </div>
    </fieldset>
  );
}

function SetupArt() {
  return (
    <aside className="setup-art">
      <Terrain />
      <span className="serial">Field kit / 001</span>
      <h2>Start with what<br />you already know.</h2>
      <p>Portable ideas follow you. The repo’s particular way of using them gets its own evidence.</p>
      <div className="impact mini">Your source name appears in the workspace switcher. Your learning evidence stays on this device.</div>
    </aside>
  );
}

function addError(cause: unknown, mapping: boolean) {
  const message = errorMessage(cause);
  if (cause instanceof IpcCallError && cause.code === 'DUPLICATE_WORKSPACE') {
    return message + ' Open it from the workspace switcher.';
  }
  return (mapping ? 'Could not attach the reviewed map request. ' : 'Could not add the workspace. ') + message;
}

function useWorkspaceActions(onAdded: Props['onAdded'], depth: Depth, provider: ProviderId) {
  const { start } = useMapJobs();
  const locked = useRef(false);
  const [pending, setPending] = useState<'pick' | 'add' | 'map' | null>(null);
  const [error, setError] = useState('');
  const [failedToken, setFailedToken] = useState<string>();

  function clearError() {
    setError('');
  }

  async function run(action: NonNullable<typeof pending>, create: () => Promise<Workspace | void>, preview?: RepoPreview) {
    if (locked.current) return;
    locked.current = true;
    setPending(action);
    clearError();
    try {
      const workspace = await create().catch((failure: unknown) => {
        setError(action === 'pick' ? 'Could not choose a folder. ' + errorMessage(failure) : addError(failure, action === 'map'));
        if (preview) setFailedToken(preview.token);
        return undefined;
      });
      if (!workspace) return;
      if (preview) start({ workspace, depth, provider, preview });
      onAdded(workspace, depth);
    } finally {
      setPending(null);
      locked.current = false;
    }
  }

  return { pending, error, failedToken, clearError, run, dropError: () => {
    setError('Could not read that drop. Choose a folder, or paste an absolute path or GitHub repository URL.');
  } };
}

function useSourceFields(actions: ReturnType<typeof useWorkspaceActions>) {
  const [kind, setKind] = useState<WorkspaceKind>('github');
  const [sources, setSources] = useState({ github: '', git: '', topic: '' });
  const value = sources[kind];
  const source = useMemo(() => kind === 'topic' ? undefined : repositoryInput(value), [kind, value]);

  function change(nextKind: WorkspaceKind, text: string) {
    actions.clearError();
    setSources(previous => ({ ...previous, [nextKind]: text }));
    setKind(nextKind);
  }

  return {
    kind, value, source,
    onKind: (next: WorkspaceKind) => { setKind(next); if (kind !== next) actions.clearError(); },
    onValue: (text: string) => change(kind === 'topic' ? kind : repositoryInput(text)?.kind ?? kind, text),
    onPick: () => void actions.run('pick', async () => {
      const path = await call('workspaces:pick-folder', null);
      if (path !== null) change('git', path);
    }),
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (actions.pending) return;
      const transfer = event.dataTransfer;
      const file = transfer.files[0];
      const nativePath = file ? window.delve?.droppedPath?.(file) : undefined;
      const text = nativePath || droppedSource(transfer.getData('text/uri-list'), transfer.getData('text/plain'));
      const repository = repositoryInput(text);
      if (repository) change(repository.kind, text);
      else actions.dropError();
    },
  };
}

function WorkspaceEditor({ onAdded, onCancel, onOpenSwitcher, firstRun }: Props) {
  const [provider, setProvider] = useState(preferredProvider);
  const [depth, setDepth] = useState<Depth>(DEFAULT_DEPTH);
  const detection = useProviderDetection();
  const cli = detection.statuses.find(status => status.id === provider);
  const actions = useWorkspaceActions(onAdded, depth, provider);
  const source = useSourceFields(actions);
  const inventory = useAttachInventory(source.source, cli);
  const snapshot = inventory.snapshot;
  const files = useAttachFiles(source.source, snapshot?.inventory);
  const request = useAttachPreview(snapshot?.workspace.id, snapshot?.inventory.commit, files.selected, depth, provider, cli?.state === 'signed-in');
  const preview = request.preview;
  const attachFailed = preview && actions.failedToken === preview.token;

  function addOnly() {
    void actions.run('add', async () => call('workspaces:add', source.source ?? workspaceInput(source.kind, source.value)));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!preview) addOnly();
  }

  function buildMap() {
    if (preview && !attachFailed) void actions.run('map', () => call('repo:attach', { token: preview.token }), preview);
  }

  return (
    <form className="sheet setup-form" aria-label="Add workspace" onSubmit={submit}>
      <fieldset className="setup-controls" disabled={actions.pending !== null}>
        <SourceFields {...source} />
        <StartingDepth depth={depth} onChange={next => { actions.clearError(); setDepth(next); }} />
        <SetupProvider provider={provider} detection={detection} onChange={next => { actions.clearError(); setProvider(next); }} />
        {source.kind !== 'topic' && <AttachReview inventory={inventory} request={request} depth={depth} provider={provider}
          selected={files.selected} onFiles={paths => { actions.clearError(); files.select(paths); }} />}
        {actions.error && <div className="attach-feedback"><p role="alert" className="setup-error">{actions.error}</p>
          {actions.error.includes('workspace switcher') && onOpenSwitcher
            ? <button type="button" onClick={onOpenSwitcher}>Open workspace switcher</button>
            : <button type="button" onClick={() => document.getElementById('source-input')?.focus()}>Edit source</button>}
        </div>}
        <div className="actions setup-actions">
          {preview ? <>
            {attachFailed
              ? <button type="button" onClick={() => { actions.clearError(); request.retry(); }}>Review request again</button>
              : <button className="primary-btn" type="button" onClick={buildMap} aria-describedby="attach-preview-summary">
                {actions.pending === 'map' ? 'Adding…' : 'Add and build map'}
              </button>}
            <button type="button" onClick={addOnly}>{actions.pending === 'add' ? 'Adding…' : 'Add without mapping'}</button>
          </> : <button className="primary-btn" type="submit">{actions.pending === 'add' ? 'Adding…' : 'Add to atlas →'}</button>}
          {onCancel && <button type="button" onClick={onCancel}>{firstRun ? 'Explore demo atlas' : 'Cancel'}</button>}
        </div>
      </fieldset>
    </form>
  );
}

export function AddWorkspaceForm(props: Props) {
  return (
    <>
      <div className="intro">
        <span className="eyebrow">{props.firstRun ? 'First run / Set up a workspace' : 'Add a workspace'}</span>
        <h1>What will you explore?</h1>
        <p>Start with a codebase or a subject. Choose how close to the details you want to begin.</p>
      </div>
      <div className="setup-grid">
        <WorkspaceEditor {...props} />
        <SetupArt />
      </div>
    </>
  );
}
