import { useState, type FormEvent } from 'react';
import { DEFAULT_DEPTH, DEPTHS, type Depth, type Workspace, type WorkspaceKind } from '../../shared/domain';
import { call } from './api';
import { SetupProvider } from './SetupProvider';
import { Terrain } from './Terrain';
import { workspaceInput } from './workspaceSource';
import './setup.css';

interface Props {
  onAdded: (workspace: Workspace, depth: Depth) => void;
  onCancel: () => void;
}

const SOURCES = {
  github: { label: 'GitHub URL', example: 'https://github.com/owner/repository', hint: 'A public or authorized repository. You can also enter owner/name.' },
  git: { label: 'Local folder', example: '/path/to/repository', hint: 'Choose a Git repository on this device.' },
  topic: { label: 'Any topic', example: 'e.g. Photography', hint: 'Any subject can have an atlas and its own instruments.' },
} as const;
const DEPTH_LABELS = { high: 'High · Overview', medium: 'Medium · Mechanics', low: 'Low · Detail' } as const;

interface SourceProps {
  kind: WorkspaceKind;
  value: string;
  onKind: (kind: WorkspaceKind) => void;
  onValue: (value: string) => void;
  onPick: () => void;
}

function SourceFields({ kind, value, onKind, onValue, onPick }: SourceProps) {
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
        <div className="source-control">
          <input id="source-input" aria-describedby="source-hint" required placeholder={example} value={value}
            maxLength={4096} onChange={(event) => onValue(event.target.value)} />
          {kind === 'git' && <button type="button" onClick={onPick}>Choose folder…</button>}
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

function WorkspaceEditor({ onAdded, onCancel }: Props) {
  const [kind, setKind] = useState<WorkspaceKind>('github');
  const [sources, setSources] = useState({ github: '', git: '', topic: '' });
  const [depth, setDepth] = useState<Depth>(DEFAULT_DEPTH);
  const [pending, setPending] = useState<'pick' | 'add' | null>(null);
  const [error, setError] = useState('');

  async function pickFolder() {
    if (pending) return;
    setPending('pick');
    setError('');
    try {
      const path = await call('workspaces:pick-folder', null);
      if (path !== null) setSources((previous) => ({ ...previous, git: path }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(null);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending('add');
    setError('');
    try {
      const workspace = await call('workspaces:add', workspaceInput(kind, sources[kind]));
      onAdded(workspace, depth);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(null);
    }
  }

  return (
    <form className="sheet setup-form" aria-label="Add workspace" onSubmit={submit}>
      <fieldset className="setup-controls" disabled={pending !== null}>
        <SourceFields kind={kind} value={sources[kind]} onPick={pickFolder}
          onKind={(next) => { setKind(next); setError(''); }}
          onValue={(value) => { setSources({ ...sources, [kind]: value }); setError(''); }} />
        <StartingDepth depth={depth} onChange={setDepth} />
        <SetupProvider />
        <div className="actions setup-actions">
          <button className="primary-btn" type="submit">{pending === 'add' ? 'Adding…' : 'Add to atlas →'}</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
        {error && <p role="alert" className="setup-error">{error}</p>}
      </fieldset>
    </form>
  );
}

export function AddWorkspaceForm(props: Props) {
  return (
    <>
      <div className="intro">
        <span className="eyebrow">First run / Set up a workspace</span>
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
