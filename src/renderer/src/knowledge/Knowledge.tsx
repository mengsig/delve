import { useEffect, useMemo, useRef, useState } from 'react';
import type { Depth, ProviderId } from '../../../shared/domain';
import type { GlobalKnowledgeGraph, KnowledgeConcept, MasteryState, ConnectionPreview } from '../../../shared/knowledge';
import { call } from '../api';
import { ReadState } from '../ReadState';
import { errorMessage, useRead } from '../useRead';
import { KnowledgeMap } from './KnowledgeMap';
import { workspaceColor } from './colors';
import './knowledge.css';

interface Props { onOpen: (workspaceId: string, conceptId: number, target: 'lesson' | 'review' | 'atlas', depth?: Depth) => void }
type Filters = { workspace: string; state: string; depth: string; query: string; group: boolean };
const defaults: Filters = { workspace: '', state: '', depth: '', query: '', group: false };
const read = () => call('knowledge:read', null);
const labels: Record<MasteryState, string> = { verified: 'Understood', 'in-progress': 'In progress', skipped: 'Skipped', 'not-started': 'Not started' };
function savedFilters(): Filters {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('delve.knowledge.filters') ?? '{}');
    if (!value || typeof value !== 'object') return defaults;
    const saved = value as Record<string, unknown>;
    return { workspace: typeof saved.workspace === 'string' ? saved.workspace : '',
      state: typeof saved.state === 'string' ? saved.state : '', depth: typeof saved.depth === 'string' ? saved.depth : '',
      query: typeof saved.query === 'string' ? saved.query : '', group: saved.group === true };
  }
  catch { return defaults; }
}
export function Knowledge({ onOpen }: Props) {
  const { result, refresh } = useRead(read);
  if (result.status !== 'ready') return <ReadState label="Knowledge" retry={refresh} message={result.status === 'error' ? result.message : undefined} />;
  return <KnowledgePage graph={result.value} refresh={refresh} onOpen={onOpen} />;
}

function KnowledgePage({ graph, refresh, onOpen }: Props & { graph: GlobalKnowledgeGraph; refresh: () => void }) {
  const [filters, setFilters] = useState(savedFilters);
  const [selected, setSelected] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [showList, setShowList] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { localStorage.setItem('delve.knowledge.filters', JSON.stringify(filters)); }, [filters]);
  const workspaces = useMemo(() => [...new Map(graph.concepts.flatMap(c => c.memberships).map(w => [w.workspaceId, w])).values()]
    .sort((a, b) => a.workspaceName.localeCompare(b.workspaceName)), [graph]);
  const visible = useMemo(() => new Set(graph.concepts.filter(c => (!filters.workspace || c.memberships.some(w => w.workspaceId === filters.workspace))
    && (!filters.state || c.masteryState === filters.state) && (!filters.depth || c.masteredDepth === filters.depth)
    && (!filters.query || `${c.title} ${c.summary}`.toLowerCase().includes(filters.query.toLowerCase()))).map(c => c.id)), [graph, filters]);
  const focus = useMemo(() => {
    if (!focused || selected === null) return null;
    const result = new Set([selected]);
    for (const edge of graph.edges) {
      if (edge.conceptId === selected) result.add(edge.prerequisiteId);
      if (edge.prerequisiteId === selected) result.add(edge.conceptId);
    }
    for (const link of graph.links) {
      if (link.fromConceptId === selected) result.add(link.toConceptId);
      if (link.toConceptId === selected) result.add(link.fromConceptId);
    }
    return result;
  }, [graph, focused, selected]);
  const chosen = graph.concepts.find(c => c.id === selected);
  const learned = graph.concepts.filter(c => c.masteryState === 'verified');
  const set = (key: keyof Filters, value: string | boolean) => setFilters(old => ({ ...old, [key]: value }));
  if (!graph.concepts.length) return <section className="knowledge-empty"><h1>Your knowledge, connected</h1>
    <p>As you learn in topics and repositories, concepts and their connections will appear here. Add a workspace to begin.</p></section>;
  return <section className="knowledge">
    <div className="knowledge-heading"><div><p className="eyebrow">YOUR LEARNING / ALL WORKSPACES</p><h1>Knowledge<span className="atlas-period">.</span></h1>
      <p>{learned.length} {learned.length === 1 ? 'concept' : 'concepts'} understood across {new Set(learned.flatMap(c => c.memberships.map(w => w.workspaceId))).size} workspaces · {graph.concepts.filter(c => c.bridge).length} shared</p></div>
      <div className="actions"><button onClick={() => setShowList(!showList)}>{showList ? 'Show graph' : 'Everything I’ve learned'}</button></div></div>
    <div className="knowledge-filters">
      <label>Search <input type="search" value={filters.query} onChange={e => set('query', e.target.value)} placeholder="Search concepts" /></label>
      <label>Workspace <select value={filters.workspace} onChange={e => set('workspace', e.target.value)}><option value="">All workspaces</option>{workspaces.map(w => <option key={w.workspaceId} value={w.workspaceId}>{w.workspaceName}</option>)}</select></label>
      <label>State <select value={filters.state} onChange={e => set('state', e.target.value)}><option value="">All states</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Depth <select value={filters.depth} onChange={e => set('depth', e.target.value)}><option value="">All depths</option><option value="high">High level</option><option value="medium">Medium</option><option value="low">Deep</option></select></label>
    </div>
    <div className="knowledge-body"><div className="knowledge-main">
      {showList ? <LearnedList graph={graph} concepts={learned.filter(c => visible.has(c.id))} group={filters.group} setGroup={value => set('group', value)} onSelect={setSelected} onOpen={onOpen} />
        : <><KnowledgeMap graph={graph} selected={selected} visible={visible} focus={focus} onSelect={setSelected} />
          <p className="knowledge-legend"><span>● Understood: H high level, M medium, D deep</span><span>● In progress</span><span>● Not started</span><span>● Skipped</span><span>◎ Shared across workspaces</span><span>— Prerequisite</span><span>╌ Transfer</span></p>
          <div className="knowledge-key" aria-label="Workspace colours"><span>Node rings show workspace membership:</span>{workspaces.map(w => <button key={w.workspaceId} onClick={() => set('workspace', filters.workspace === w.workspaceId ? '' : w.workspaceId)}><span style={{ color: workspaceColor(w.workspaceId) }}>●</span> {w.workspaceName}</button>)}</div></>}
      {filters.query && <div className="knowledge-search-results" aria-label="Search results">{graph.concepts.filter(c => visible.has(c.id)).slice(0, 30).map(c => <button key={c.id} onClick={() => setSelected(c.id)}>{c.title}</button>)}</div>}
    </div><aside className="knowledge-detail">{chosen ? <Detail graph={graph} concept={chosen} focused={focused} onFocus={() => setFocused(!focused)}
      onSelect={setSelected} onOpen={onOpen} refresh={refresh} onError={setError} /> : <><h2>Select a concept</h2><p>Choose a point, search by name, or open your learned list to see how ideas connect.</p></>}
      {error && <p role="alert">{error}</p>}</aside></div>
  </section>;
}

function LearnedList({ graph, concepts, group, setGroup, onSelect, onOpen }: { graph: GlobalKnowledgeGraph; concepts: KnowledgeConcept[]; group: boolean; setGroup: (value: boolean) => void; onSelect: (id: number) => void; onOpen: Props['onOpen'] }) {
  const [scroll, setScroll] = useState(0);
  const rows = useMemo(() => {
    const sorted = [...concepts].sort((a, b) => (b.learnedAt ?? '').localeCompare(a.learnedAt ?? ''));
    return group ? sorted.flatMap(c => c.memberships.map(w => ({ concept: c, workspace: w.workspaceName }))).sort((a, b) => a.workspace.localeCompare(b.workspace))
      : sorted.map(concept => ({ concept, workspace: concept.memberships.map(w => w.workspaceName).join(', ') }));
  }, [concepts, group]);
  const transfers = useMemo(() => {
    const titles = new Map(graph.concepts.map(c => [c.id, c.title]));
    const result = new Map<number, string[]>();
    for (const link of graph.links) {
      for (const [id, other] of [[link.fromConceptId, link.toConceptId], [link.toConceptId, link.fromConceptId]]) {
        const list = result.get(id!) ?? []; list.push(titles.get(other!) ?? ''); result.set(id!, list);
      }
    }
    return result;
  }, [graph]);
  const rowHeight = 76; const first = Math.min(Math.max(0, rows.length - 1), Math.max(0, Math.floor(scroll / rowHeight) - 3)); const count = 15;
  return <><div className="knowledge-list-heading"><h2>Everything I’ve learned</h2><label><input type="checkbox" checked={group} onChange={e => setGroup(e.target.checked)} /> Group by workspace</label></div>
    <div className="knowledge-list" onScroll={e => setScroll(e.currentTarget.scrollTop)}><div style={{ height: rows.length * rowHeight, position: 'relative' }}>
      {rows.slice(first, first + count).map(({ concept, workspace }, index) => {
        const membership = concept.memberships.find(member => member.workspaceId === concept.learnedWorkspaceId) ?? concept.memberships[0];
        return <div className="knowledge-list-row" key={`${concept.id}-${workspace}`} style={{ top: (first + index) * rowHeight, height: rowHeight }}>
          <button className="knowledge-list-select" onClick={() => onSelect(concept.id)}>
            <strong>{concept.title}</strong><span>{concept.masteredDepth} depth · {concept.learnedAt ? new Date(concept.learnedAt).toLocaleDateString() : 'Date unavailable'} · {workspace}{transfers.get(concept.id)?.length ? ` · Transfers: ${transfers.get(concept.id)!.join(', ')}` : ''}</span>
          </button>
          {membership && <button onClick={() => onOpen(membership.workspaceId, concept.id, 'lesson', concept.masteredDepth ?? undefined)} aria-label={`Open lesson: ${concept.title}`}>Open lesson</button>}
        </div>;
      })}</div>{!rows.length && <p>No understood concepts match these filters yet.</p>}</div></>;
}

function Detail({ graph, concept, focused, onFocus, onSelect, onOpen, refresh, onError }: {
  graph: GlobalKnowledgeGraph; concept: KnowledgeConcept; focused: boolean; onFocus: () => void; onSelect: (id: number) => void;
  onOpen: Props['onOpen']; refresh: () => void; onError: (error: string) => void;
}) {
  const byId = new Map(graph.concepts.map(c => [c.id, c]));
  const prerequisites = graph.edges.filter(e => e.conceptId === concept.id).map(e => byId.get(e.prerequisiteId)).filter(c => c !== undefined);
  const dependents = graph.edges.filter(e => e.prerequisiteId === concept.id).map(e => byId.get(e.conceptId)).filter(c => c !== undefined);
  const links = graph.links.filter(link => link.fromConceptId === concept.id || link.toConceptId === concept.id);
  const workspace = concept.memberships.find(member => member.workspaceId === concept.learnedWorkspaceId) ?? concept.memberships[0];
  async function remove(id: number) {
    try { await call('knowledge:remove-link', { id }); refresh(); }
    catch (error) { onError(errorMessage(error)); }
  }
  return <><p className="eyebrow">CONCEPT {concept.bridge && ' / SHARED'}</p><h2>{concept.title}</h2><p>{concept.summary}</p>
    <p><strong>{labels[concept.masteryState]}</strong>{concept.masteredDepth && ` · ${concept.masteredDepth} depth`}</p>
    <p>Used in {concept.memberships.map(w => w.workspaceName).join(', ')}.</p>
    <div className="knowledge-actions">{workspace && <><button className="primary-btn" onClick={() => onOpen(workspace.workspaceId, concept.id, 'lesson', concept.masteredDepth ?? undefined)}>Open lesson</button>
      {concept.masteredDepth && <button onClick={() => onOpen(workspace.workspaceId, concept.id, 'review', concept.masteredDepth ?? undefined)}>Review</button>}
      <button onClick={() => onOpen(workspace.workspaceId, concept.id, 'atlas')}>Show in workspace Atlas</button></>}
      <button onClick={onFocus}>{focused ? 'Show all connections' : 'Focus neighbourhood'}</button></div>
    <Related title="Prerequisites" concepts={prerequisites} onSelect={onSelect} />
    <Related title="Dependents" concepts={dependents} onSelect={onSelect} />
    <h3>Transfers</h3>{links.length ? <ul>{links.map(link => {
      const other = byId.get(link.fromConceptId === concept.id ? link.toConceptId : link.fromConceptId);
      return <li key={link.id}><button className="knowledge-link" onClick={() => other && onSelect(other.id)}>{other?.title}</button>
        <p>{link.reason} <small>Proposed by {link.provider} · {link.model}</small></p><button onClick={() => void remove(link.id)}>Remove link</button></li>;
    })}</ul> : <p>No transfer links yet.</p>}
    <Connections key={concept.id} concept={concept} refresh={refresh} />
  </>;
}
function Related({ title, concepts, onSelect }: { title: string; concepts: KnowledgeConcept[]; onSelect: (id: number) => void }) {
  return <><h3>{title}</h3>{concepts.length ? <ul>{concepts.map(c => <li key={c.id}><button className="knowledge-link" onClick={() => onSelect(c.id)}>{c.title}</button></li>)}</ul> : <p>None</p>}</>;
}
function Connections({ concept, refresh }: { concept: KnowledgeConcept; refresh: () => void }) {
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
