import { useMemo, useState } from 'react';
import type { Depth, Workspace } from '../../../shared/domain';
import type { WorkspaceGraph } from '../../../shared/graph';
import { ContourMap } from './ContourMap';
import { demoPlate } from './demoAtlas';
import { FieldGuide } from './FieldGuide';
import { Folio, Inspector } from './Folio';
import { buildAtlas, isLearned, nextConcept, statusText, type AtlasModel } from './model';

export type AtlasView = 'contour' | 'folio';

export interface AtlasProps {
  workspace: Workspace;
  graph: WorkspaceGraph;
  depth: Depth;
  view: AtlasView;
  initialConceptId?: number;
  onView: (view: AtlasView) => void;
  onLesson: (id: number) => void;
  onChanges: () => void;
  onProgress: () => void;
  onAdd: () => void;
  onStartTopic: () => Promise<void>;
  onSwitch: () => void;
}

function Topline({ workspace, name, blurb, onSwitch }: Pick<AtlasProps, 'workspace' | 'onSwitch'> & {
  name: string; blurb: string;
}) {
  const kind = workspace.kind === 'topic' ? 'Topic' : 'Repository';
  return <header className="topline">
    <div><span className="eyebrow">Personal atlas &nbsp; / &nbsp; {name}</span>
      <h1>{kind} atlas<span className="atlas-period">.</span></h1><p>{blurb}</p>
    </div>
    <div className="scope atlas-scope">
      <label htmlFor="atlas-workspace">Workspace</label>
      <button id="atlas-workspace" aria-label={'Switch workspace, ' + workspace.name} aria-haspopup="dialog" onClick={onSwitch}>
        {workspace.name} · {kind}<span aria-hidden="true">⌄</span>
      </button>
    </div>
  </header>;
}

function AtlasFooter({ model, depth, onProgress, view, onView }: Pick<AtlasProps, 'depth' | 'onProgress' | 'view' | 'onView'> & {
  model: AtlasModel;
}) {
  return <footer className="case">
    <span><strong>{model.learned} of {model.byId.size}</strong> concepts learned at {depth} depth ·{' '}
      <button className="back" onClick={onProgress}>View progress ↗</button></span>
    <div className="row wrap"><span className="plate">Atlas view</span>
      <div className="seg" role="group" aria-label="Atlas view">
        <button aria-pressed={view === 'contour'} onClick={() => onView('contour')}>Terrain</button>
        <button aria-pressed={view === 'folio'} onClick={() => onView('folio')}>Ledger</button>
      </div>
    </div>
  </footer>;
}

function StartTopic({ start }: { start: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function open() {
    setBusy(true);
    setError('');
    try { await start(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <><button className="primary-btn" disabled={busy} onClick={() => void open()}>Start a topic lesson →</button>
    {error && <p role="alert">{error}</p>}</>;
}

function WorkspaceAtlas({ model, ...props }: AtlasProps & { model: AtlasModel }) {
  const { workspace, graph, depth, view, onLesson, onSwitch, onChanges } = props;
  const demo = useMemo(() => demoPlate(graph, model), [graph, model]);
  const suggestion = graph.suggestions?.[depth];
  const suggested = suggestion && model.byId.get(suggestion.conceptId);
  const adaptive = suggested && !isLearned(suggested) ? suggested : undefined;
  const fallback = useMemo(() => nextConcept(model, demo?.primary), [model, demo]);
  const target = adaptive ?? fallback;
  const [selection, setSelection] = useState(props.initialConceptId ?? demo?.primary.id ?? target?.id);
  const selected = (selection === undefined ? undefined : model.byId.get(selection)) ?? target;
  const recommendedId = target && !isLearned(target) ? target.id : undefined;
  const name = graph.demo ? workspace.name.replace(/ \(demo\)$/, '') : workspace.name;
  const blurb = demo?.blurb ?? (workspace.kind === 'topic'
    ? 'Explore the ideas in ' + name + ' and the connections between them.'
    : 'Follow the concepts and dependencies in ' + name + '.');
  return <div className={'atlas ' + view}>
    <Topline workspace={workspace} name={name} blurb={blurb} onSwitch={onSwitch} />
    {selected && target ? <div className="split"><div>
      {view === 'contour'
        ? <ContourMap model={model} selected={selected} recommendedId={recommendedId} workspaceId={workspace.id} depth={depth}
          name={name} demo={demo} onSelect={setSelection} />
        : <Folio model={model} selected={selected} recommendedId={recommendedId} workspaceId={workspace.id} changedId={demo?.changed?.id} onSelect={setSelection} />}
      <Inspector selected={selected} status={statusText(selected, workspace.id, selected.id === demo?.changed?.id)}
        onSelect={setSelection} onLesson={onLesson} />
    </div><FieldGuide model={model} target={target} reason={adaptive && suggestion?.reason} workspace={workspace} demo={demo} onLesson={onLesson} onChanges={onChanges} /></div>
      : <section className="sheet atlas-empty"><h3>No concepts mapped yet</h3>
        <p>This workspace has no saved concepts to explore.</p>
        <div className="actions">{workspace.kind === 'topic' && <StartTopic start={props.onStartTopic} />}
          <button onClick={onSwitch}>Switch workspace</button>
          <button onClick={props.onAdd}>Add workspace</button></div>
      </section>}
    <AtlasFooter model={model} depth={depth} onProgress={props.onProgress} view={view} onView={props.onView} />
  </div>;
}

export function Atlas(props: AtlasProps) {
  const { workspace, graph, depth } = props;
  const result = useMemo(() => {
    try {
      if (workspace.id !== graph.workspaceId) throw new Error('This graph belongs to another workspace.');
      return buildAtlas(graph, depth);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }, [workspace.id, graph, depth]);
  if (result instanceof Error) return <section className="sheet atlas-empty">
    <h3>Atlas unavailable</h3><p role="alert">{result.message}</p><button onClick={props.onSwitch}>Switch workspace</button>
  </section>;
  return <WorkspaceAtlas key={workspace.id} {...props} model={result} />;
}
