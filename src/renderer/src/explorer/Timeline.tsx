import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryNode } from '../../../shared/explorer';
import type { ChangeRef } from '../../../shared/repository';
import { atlasView, type AtlasView } from '../preferences';
import { HistoryNotice, HistoryViewport } from './HistoryViewport';
import { layoutLanes } from './lanes';
import { useHistory, type HistoryFilters } from './useHistory';
import './timeline.css';

interface TimelineProps {
  workspaceId: string;
  selected?: ChangeRef;
  onSelect: (node: ChangeRef, title?: string) => void;
  onClear: () => void;
  onOpen?: () => void;
  onRefresh?: () => void;
}

type Draft = { [Field in keyof Required<HistoryFilters>]: string };
const emptyFilters: Draft = { author: '', branch: '', kind: '', search: '' };
const noNodes: HistoryNode[] = [];

function useSearch(text: string) {
  const [value, setValue] = useState(text);
  useEffect(() => {
    const timer = window.setTimeout(() => setValue(text), text ? 240 : 0);
    return () => window.clearTimeout(timer);
  }, [text]);
  return value;
}

interface ControlsProps {
  draft: Draft;
  branches: string[];
  view: AtlasView;
  onChange: (draft: Draft) => void;
  onView: (view: AtlasView) => void;
}

function TimelineControls({ draft, branches, view, onChange, onView }: ControlsProps) {
  const search = useRef<HTMLInputElement>(null);
  const filtered = Object.values(draft).some(Boolean);
  return <>
    <div className="timeline-heading">
      <h2 id="change-timeline-label">History</h2>
      <div className="seg" role="group" aria-label="History view">
        <button type="button" aria-pressed={view === 'contour'} onClick={() => onView('contour')}>Contour</button>
        <button type="button" aria-pressed={view === 'folio'} onClick={() => onView('folio')}>Folio</button>
      </div>
    </div>
    <div className="timeline-controls" role="group" aria-label="History filters">
      <label className="timeline-search">Search history
        <input type="search" ref={search} value={draft.search} onChange={event => onChange({ ...draft, search: event.target.value })}
          placeholder="Title or reference" maxLength={120} />
      </label>
      <label>Changes
        <select value={draft.kind} onChange={event => onChange({ ...draft, kind: event.target.value })}>
          <option value="">All changes</option><option value="commit">Commits</option><option value="pr">Pull requests</option>
        </select>
      </label>
      <label>Branch
        <select value={draft.branch} onChange={event => onChange({ ...draft, branch: event.target.value })}>
          <option value="">All branches</option>
          {draft.branch && !branches.includes(draft.branch) && <option value={draft.branch}>{draft.branch}</option>}
          {branches.map(branch => <option key={branch} value={branch}>{branch}</option>)}
        </select>
      </label>
      <label>Author
        <input type="search" value={draft.author} onChange={event => onChange({ ...draft, author: event.target.value })}
          maxLength={120} placeholder="Any author" />
      </label>
      {filtered && <button className="timeline-clear" type="button" onClick={() => {
        onChange(emptyFilters);
        search.current?.focus();
      }}>Clear filters</button>}
    </div>
  </>;
}

function TimelineFeedback({ history, filters, onRefresh }: { history: ReturnType<typeof useHistory>; filters: HistoryFilters; onRefresh?: () => void }) {
  const { page, loading, error, retry, loadMore, hasRequestedMore } = history;
  const empty = page && page.nodes.length === 0 && page.next === null;
  const pullOnly = filters.kind === 'pr';
  const pullStatusExplained = pullOnly && ['empty', 'local', 'unavailable'].some(status => status === page?.pullStatus);
  const isFiltered = Boolean(filters.author || filters.branch || filters.search || filters.kind);
  return <>
    {empty && !pullStatusExplained && (isFiltered || !page?.warning) && <p className="timeline-message" role="status">
      {isFiltered ? 'No changes match these filters. Clear the filters to see more history.'
        : 'No commits or pull requests are available. After a change is committed, refresh history.'}
    </p>}
    {page && page.nodes.length === 0 && page.next !== null && !loading && !error &&
      <p className="timeline-message" role="status">No matches in the loaded history.</p>}
    {error && <p className="timeline-message" role="alert">{error}</p>}
    {loading && <p className="timeline-message" role="status">{page ? 'Loading more changes…' : 'Loading history…'}</p>}
    <div className="timeline-actions">
      <button type="button" disabled={loading} onClick={() => history.refresh(true, onRefresh)}>Refresh history</button>
      {(error || hasRequestedMore || page?.next != null) &&
      <button type="button" aria-disabled={loading || (!error && page?.next == null)}
        onClick={error ? retry : loadMore}>
        {error ? 'Retry history' : page?.next == null && !loading ? 'All changes loaded' : 'Load more changes'}
      </button>}
    </div>
  </>;
}

interface ResultProps extends TimelineProps {
  filters: HistoryFilters;
  pendingFilters: boolean;
  view: AtlasView;
  onBranches: (branches: string[]) => void;
  onInitialNode: (node: HistoryNode) => void;
}

function TimelineResults({ workspaceId, selected, onSelect, onOpen, onRefresh, filters, pendingFilters, view, onBranches, onInitialNode }: ResultProps) {
  const query = JSON.stringify(filters);
  const history = useHistory(workspaceId, filters, query);
  const { page } = history;
  const nodes = pendingFilters ? noNodes : page?.nodes ?? noNodes;
  const branches = page?.branches;
  const latest = nodes[0];
  const more = page?.next != null;
  const carryLanes = more && !filters.search && !filters.author && filters.kind !== 'pr';
  const layout = useMemo(() => view === 'contour' ? layoutLanes(nodes, carryLanes) : undefined, [view, nodes, carryLanes]);
  useEffect(() => {
    if (branches) onBranches(branches);
    if (latest) onInitialNode(latest);
  }, [onBranches, branches, onInitialNode, latest]);

  return <>
    {!pendingFilters && page && <HistoryNotice page={page} />}
    <HistoryViewport query={query} nodes={nodes} layout={layout} selected={selected} more={more}
      loadMore={history.loadMore} onSelect={onSelect} onOpen={onOpen} />
    {pendingFilters ? <p className="timeline-message" role="status">Updating history…</p>
      : <TimelineFeedback history={history} filters={filters} onRefresh={onRefresh} />}
  </>;
}

function WorkspaceTimeline(props: TimelineProps) {
  const { selected, onSelect } = props;
  const [draft, setDraft] = useState<Draft>(emptyFilters);
  const [branches, setBranches] = useState<string[]>([]);
  const [view, setView] = useState(atlasView);
  const seeded = useRef(false);
  const search = useSearch(draft.search.trim());
  const author = useSearch(draft.author.trim());
  const filters: HistoryFilters = {
    search: draft.search ? search || undefined : undefined,
    author: draft.author ? author || undefined : undefined,
    branch: draft.branch || undefined,
    kind: draft.kind === 'pr' || draft.kind === 'commit' ? draft.kind : undefined,
  };
  const initialNode = useCallback(({ kind, ref, title }: HistoryNode) => {
    if (seeded.current) return;
    seeded.current = true;
    if (!selected) onSelect({ kind, ref }, title);
  }, [onSelect, selected]);

  return <section className="timeline" aria-labelledby="change-timeline-label">
    <TimelineControls draft={draft} branches={branches} view={view} onChange={next => {
      setDraft(next);
      if (selected) props.onClear();
    }} onView={setView} />
    <TimelineResults {...props} filters={filters} pendingFilters={draft.search.trim() !== search || draft.author.trim() !== author} view={view}
      onBranches={setBranches} onInitialNode={initialNode} />
  </section>;
}

export function Timeline(props: TimelineProps) {
  return <WorkspaceTimeline key={props.workspaceId} {...props} />;
}
