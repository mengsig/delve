import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Depth, Workspace } from '../../../shared/domain';
import type { GlobalKnowledgeGraph, KnowledgeMembership } from '../../../shared/knowledge';
import { call } from '../api';
import { Icon } from '../Icon';
import { buildLearningProgress } from '../progress/model';
import { useProviderDetection } from '../SetupProvider';
import { ReadState } from '../ReadState';
import { useBackgroundTutorCompletion } from '../reader/TutorJobs';
import { errorMessage, useRead } from '../useRead';
import { graphInArea, mapPlaces, mapWorkspaces, neighbourhood, suggestedLesson, visibleConcepts, type LearningArea } from './areas';
import { Finder } from './Finder';
import { AreaProgress, Inspector } from './Inspector';
import { KnowledgeMap } from './KnowledgeMap';
import { LearnedList } from './LearnedList';
import { AreaBar, Legend, MapHeading } from './MapHeader';
import { anyWorkspace, rememberFilters, savedFilters, type knowledgeHistoryView, type Filters, type KnowledgeView } from './view';
import './knowledge.css';

type OpenConcept = (workspaceId: string, id: number, target: 'lesson' | 'review' | 'atlas', depth?: Depth) => void;
export interface KnowledgeActions { onOpen: OpenConcept }
interface Props {
  active?: Workspace;
  depth: Depth;
  onDepth: (depth: Depth) => void;
  onOpen: (...args: Parameters<OpenConcept>) => Promise<void>;
  onProgress: (workspaceId: string) => void;
  onAdd: () => void;
  onBack: () => void;
  backLabel?: string;
  historyView: ReturnType<typeof knowledgeHistoryView>;
}

function initialView(active?: Workspace): KnowledgeView {
  return { demo: false, filters: savedFilters(active?.id), selected: null, focused: false, list: false, finder: false, details: false };
}

export function Knowledge(props: Props) {
  const { active, historyView } = props;
  const [view, setView] = useState(() => historyView.read() ?? initialView(active));
  const [failure, setFailure] = useState('');
  const read = useCallback(() => call('knowledge:read', view.demo ? { demo: true } : null), [view.demo]);
  const { result, refresh } = useRead(read);
  useBackgroundTutorCompletion(refresh);
  useEffect(() => { historyView.save(view); }, [historyView, view]);
  const update = (patch: Partial<KnowledgeView>) => setView(previous => ({ ...previous, ...patch }));
  function updateFilters(patch: Partial<Filters>) {
    const filters = { ...view.filters, ...patch };
    if (!view.demo) rememberFilters(filters);
    update({ filters, focused: false });
  }
  function toggleDemo() {
    setView({ ...initialView(active), demo: !view.demo, filters: view.demo ? savedFilters(active?.id)
      : { workspace: active?.id ?? anyWorkspace, query: '', state: '', depth: '', group: false } });
  }
  const onOpen: OpenConcept = (workspace, id, target, depth) => {
    setFailure('');
    void props.onOpen(workspace, id, target, depth).catch(cause => setFailure(errorMessage(cause)));
  };
  if (result.status !== 'ready') return <ReadState label="Knowledge" retry={refresh} message={result.status === 'error' ? result.message : undefined} />;
  const graph = result.value;
  const hasConcepts = graph.concepts.length > 0;
  return <section className="knowledge">
    <MapHeading back={view.demo ? toggleDemo : props.onBack} backLabel={view.demo ? '← Personal knowledge' : props.backLabel}
      demo={view.demo} depth={props.depth} onDepth={props.onDepth} finder={view.finder}
      toggleFinder={hasConcepts ? () => update({ finder: !view.finder }) : undefined} />
    {failure && <p role="alert">{failure}</p>}
    {hasConcepts ? <AreaPage graph={graph} activeId={active?.id} depth={props.depth} view={view} update={update}
      historyView={historyView} updateFilters={updateFilters} onOpen={onOpen} onProgress={props.onProgress} refresh={refresh} />
      : <div className="knowledge-empty"><Icon name="atlas" /><h2>Your knowledge, connected</h2>
        <p>Add a topic or map a repository to see your concepts.</p><button className="primary-btn" onClick={props.onAdd}>Add a workspace</button>
        {!view.demo && active?.source.startsWith('Demo: ') && <button onClick={toggleDemo}>Explore the demo map</button>}</div>}
  </section>;
}

interface AreaProps extends KnowledgeActions {
  historyView: Props['historyView'];
  graph: GlobalKnowledgeGraph;
  activeId?: string;
  depth: Depth;
  view: KnowledgeView;
  update: (patch: Partial<KnowledgeView>) => void;
  updateFilters: (patch: Partial<Filters>) => void;
  onProgress: Props['onProgress'];
  refresh: () => void;
}

function AreaPage(props: AreaProps) {
  const { graph, view, depth } = props;
  const { demo } = view;
  const detection = useProviderDetection(!demo);
  const workspaces = useMemo(() => mapWorkspaces(graph), [graph]);
  const workspace = workspaces.some(w => w.workspaceId === view.filters.workspace) ? view.filters.workspace : anyWorkspace;
  const scope = useMemo(() => workspaces.filter(w => workspace === anyWorkspace || w.workspaceId === workspace), [workspaces, workspace]);
  const read = useCallback(async () => Promise.all(scope.map(async w => {
    const projection = await call('graph:read', { workspaceId: w.workspaceId, depth, includeChangeLessons: true });
    if (projection.workspaceId !== w.workspaceId || projection.demo !== demo) throw new Error('This workspace changed. Reload the knowledge map.');
    return { ...w, progress: buildLearningProgress(projection, depth) };
  })), [scope, depth, demo]);
  const { result, refresh } = useRead(read);
  const local = useMemo(() => graphInArea(graph, workspace), [graph, workspace]);
  if (result.status !== 'ready') return <ReadState label="Area progress" retry={props.refresh} message={result.status === 'error' ? result.message : undefined} />;
  return <AreaContents {...props} workspaces={workspaces} workspace={workspace} local={local} areas={result.value}
    detection={detection} retryProgress={refresh} />;
}

interface ContentsProps extends AreaProps {
  detection: ReturnType<typeof useProviderDetection>;
  workspaces: KnowledgeMembership[];
  workspace: string;
  local: GlobalKnowledgeGraph;
  areas: LearningArea[];
  retryProgress: () => void;
}

function useMapModel({ local, activeId, areas, view }: ContentsProps) {
  const places = useMemo(() => mapPlaces(local, areas, activeId), [local, areas, activeId]);
  const visible = useMemo(() => visibleConcepts(local, places, view.filters), [local, places, view.filters]);
  const suggestion = useMemo(() => suggestedLesson(areas, places, visible, activeId), [areas, places, visible, activeId]);
  const selected = view.selected !== null && visible.has(view.selected) ? view.selected : suggestion;
  const focus = useMemo(() => view.focused && selected !== null ? neighbourhood(local, selected) : null, [local, view.focused, selected]);
  const states = useMemo(() => new Map([...places].map(([id, place]) => [id, place.state])), [places]);
  const matches = useMemo(() => local.concepts.filter(c => visible.has(c.id)), [local, visible]);
  const chosen = selected !== null && local.concepts.find(c => c.id === selected);
  const place = chosen && places.get(chosen.id);
  return { places, visible, states, suggestion, selected, focus, matches, chosen, place };
}
type Model = ReturnType<typeof useMapModel>;

function AreaContents(props: ContentsProps) {
  const { graph, local, workspaces, workspace, view, update, updateFilters, depth } = props;
  const model = useMapModel(props);
  const open: OpenConcept = (...args) => {
    props.historyView.save({ ...view, selected: model.selected });
    props.onOpen(...args);
  };
  const clear = () => updateFilters({ query: '', state: '', depth: '' });
  function select(id: number) {
    const concept = graph.concepts.find(c => c.id === id);
    if (!concept) return;
    if (!model.visible.has(id)) {
      const area = concept.memberships.some(w => w.workspaceId === workspace) || workspace === anyWorkspace
        ? workspace : concept.memberships[0]!.workspaceId;
      updateFilters({ workspace: area, query: '', state: '', depth: '' });
    }
    update({ selected: id, details: true, focused: false });
  }
  const filtered = !!(view.filters.query || view.filters.state || view.filters.depth);
  const learned = useMemo(() => model.matches.filter(c => c.masteredDepth), [model.matches]);
  return <>
    {view.finder && <Finder filters={view.filters} update={updateFilters} matches={model.matches} reset={clear} select={c => select(c.id)} />}
    <div className="knowledge-body"><section className="knowledge-main" aria-label="Area map">
      <AreaBar workspace={workspace} workspaces={workspaces} count={local.concepts.length} onArea={id => {
        updateFilters({ workspace: id }); update({ selected: null, details: false });
      }} list={view.list} toggleList={() => update({ list: !view.list })} />
      {view.list ? <LearnedList areaId={workspace} graph={graph} concepts={learned} group={view.filters.group}
        setGroup={group => updateFilters({ group })} onSelect={select} onOpen={open} />
        : <div className="knowledge-map-slot"><div inert={!model.visible.size}><KnowledgeMap cameras={props.historyView.cameras} areaKey={(view.demo ? 'demo/' : 'personal/') + workspace}
          graph={local} visible={model.visible} states={model.states} selected={model.selected} onSelect={select} focus={model.focus} /></div>
          {!model.visible.size && <div className="knowledge-no-matches"><Icon name="frame" /><h2>No matching concepts</h2><p>Try another name, state or verified depth.</p><button onClick={clear}>Clear filters</button></div>}</div>}
      {!view.list && <Legend transfers={local.links.length > 0} />}
    </section><aside className="knowledge-detail" aria-label="Concept guide">
      <GuideSummary {...props} model={model} />
      {model.chosen && model.place ? <Inspector key={model.chosen.id} concept={model.chosen} place={model.place} graph={graph}
        depth={depth} suggested={model.selected === model.suggestion} demo={view.demo} detection={props.detection} details={view.details}
        setDetails={details => update({ details })} focused={view.focused} focus={() => update({ selected: model.selected, focused: !view.focused })}
        onOpen={open} select={select} refresh={props.refresh} />
        : <EndOfPath {...props} model={model} />}
    </aside></div>
    <div className="knowledge-footnote">{view.list ? 'Verified concepts are ordered by the date you learned them.' : 'Drag to explore · Scroll to zoom · Select a concept to see how it connects'}
      {filtered && <button onClick={clear}>Clear map filters</button>}</div>
  </>;
}

function GuideSummary({ model, areas, workspace }: ContentsProps & { model: Model }) {
  const area = model.place ? model.place.area : areas.find(a => a.workspaceId === workspace);
  const included = area?.progress.concepts ?? [...model.places.values()].map(p => p.progress);
  const mastered = included.filter(c => c.state === 'mastered').length;
  return <AreaProgress name={area?.workspaceName ?? 'All workspaces'} mastered={mastered} total={included.length}
    available={area ? area.progress.available : areas.every(a => a.progress.available)} />;
}

function EndOfPath({ model, areas, activeId, retryProgress, onProgress }: ContentsProps & { model: Model }) {
  const progressAvailable = areas.every(a => a.progress.available);
  const complete = model.matches.length > 0 && model.matches.every(c => model.states.get(c.id) === 'mastered');
  const matches = model.matches.map(c => model.places.get(c.id)?.area);
  const area = matches.find(candidate => candidate?.workspaceId === activeId) ?? matches[0];
  if (!progressAvailable) return <div className="knowledge-path-end"><h3>Progress unavailable</h3>
    <p>Reload this area to find a lesson.</p><button onClick={retryProgress}>Retry area progress</button></div>;
  if (!model.visible.size) return <div className="knowledge-path-end"><h3>No concept selected</h3><p>Clear your filters to explore this area.</p></div>;
  return <div className="knowledge-path-end"><Icon name={complete ? 'check' : 'route'} />
    <h3>{complete ? 'Path mastered' : 'No eligible next lesson'}</h3>
    <p>{complete ? 'You’ve mastered every concept in this view at this depth.' : 'Explore a concept to see its prerequisites or choose another area.'}</p>
    {area && <button className="primary-btn" onClick={() => onProgress(area.workspaceId)}>View progress</button>}</div>;
}
