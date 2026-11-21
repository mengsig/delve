import type { ChangeRef } from '../../../shared/repository';
import { useMemo, useState, type ReactNode } from 'react';
import type { Depth, Workspace } from '../../../shared/domain';
import type { WorkspaceGraph } from '../../../shared/graph';
import { jobInProgress, mapJobKey, useMapJobs } from '../repository/MapJobs';
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
  onChanges: (change?: ChangeRef) => void;
  onProgress: () => void;
  workspaceBar: ReactNode;
  continueActivity: ReactNode;
  onMap: () => void;
  onStartTopic: () => Promise<void>;
  onSwitch: () => void;
}

function Topline({ workspace, name, blurb, continueActivity }: Pick<AtlasProps, 'workspace' | 'continueActivity'> & {
  name: string; blurb: string;
}) {
  const kind = workspace.kind === 'topic' ? 'Topic' : 'Repository';
  return <header className="topline">
    <div><span className="eyebrow">Personal atlas &nbsp; / &nbsp; {name}</span>
      <h1>{kind} atlas<span className="atlas-period">.</span></h1><p>{blurb}</p>
    </div>
    {continueActivity}
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
  return <><button className="primary-btn" disabled={busy} onClick={() => void open()}>{busy ? 'Opening lesson…' : 'Start a topic lesson →'}</button>
    {error && <p role="alert">{error}</p>}</>;
}

function EmptyAtlas({ workspace, onStartTopic, onMap }: Pick<AtlasProps, 'workspace' | 'onStartTopic' | 'onMap'>) {
  const job = useMapJobs().jobs.get(mapJobKey(workspace.id));
  if (jobInProgress(job)) return <section className="sheet atlas-empty atlas-building">
    <h3>Your map is on its way</h3><p>The concepts will appear here when they’re ready. You can explore another workspace while you wait.</p>
  </section>;
  const topic = workspace.kind === 'topic';
  return <section className="sheet atlas-empty">
    <h3>No concepts mapped yet</h3>
    <p>{topic ? 'Start a lesson to add the first concept.' : 'Choose repository files to build your first map.'}</p>
    {topic ? <StartTopic start={onStartTopic} /> : <button className="primary-btn" onClick={onMap}>Map this repository →</button>}
  </section>;
}

function WorkspaceAtlas({ model, ...props }: AtlasProps & { model: AtlasModel }) {
  const { workspace, graph, depth, view, onLesson, onChanges } = props;
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
    <Topline workspace={workspace} name={name} blurb={blurb} continueActivity={props.continueActivity} />
    {props.workspaceBar}
    {!graph.demo && workspace.kind !== 'topic' && selected &&
      <button className="repository-setup-link" onClick={props.onMap}>{graph.baselineCommit ? 'Map more files →' : 'Map this repository →'}</button>}
    {selected && target ? <div className="split"><div>
      {view === 'contour'
        ? <ContourMap model={model} selected={selected} recommendedId={recommendedId} workspaceId={workspace.id} depth={depth}
          name={name} demo={demo} onSelect={setSelection} />
        : <Folio model={model} selected={selected} recommendedId={recommendedId} workspaceId={workspace.id} changedId={demo?.changed?.id} onSelect={setSelection} />}
      <Inspector selected={selected} status={statusText(selected, workspace.id, selected.id === demo?.changed?.id)}
        onSelect={setSelection} onLesson={onLesson} />
    </div><FieldGuide suggestedChange={graph.changeSuggestions?.[depth]} model={model} target={target} reason={adaptive && suggestion?.reason} workspace={workspace} demo={demo} onLesson={onLesson} onChanges={onChanges} /></div>
      : <EmptyAtlas {...props} />}
    {selected && <AtlasFooter model={model} depth={depth} onProgress={props.onProgress} view={view} onView={props.onView} />}
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
