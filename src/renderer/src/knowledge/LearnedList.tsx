import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { GlobalKnowledgeGraph, KnowledgeConcept } from '../../../shared/knowledge';
import type { KnowledgeActions } from './Knowledge';

const ROW_HEIGHT = 76;
const MOUNTED_ROWS = 15;

interface Props {
  graph: GlobalKnowledgeGraph;
  concepts: KnowledgeConcept[];
  areaId: string;
  areaKey: string;
  positions: Map<string, number>;
  group: boolean;
  setGroup: (value: boolean) => void;
  onSelect: (id: number) => void;
  onOpen: KnowledgeActions['onOpen'];
}

interface Row {
  concept: KnowledgeConcept;
  workspace: string;
  target?: string;
}

type Anchor = { id: number; target?: string };
type RowAction = 'select' | 'lesson';

function learnedRows(concepts: KnowledgeConcept[], group: boolean, areaId: string): Row[] {
  const sorted = [...concepts].sort((a, b) => (b.learnedAt ?? '').localeCompare(a.learnedAt ?? ''));
  if (group) {
    return sorted.flatMap(concept => concept.memberships.map(workspace => ({
      concept, workspace: workspace.workspaceName, target: workspace.workspaceId,
    }))).sort((a, b) => a.workspace.localeCompare(b.workspace));
  }
  return sorted.map(concept => {
    const membership = concept.memberships.find(workspace => workspace.workspaceId === areaId)
      ?? concept.memberships.find(workspace => workspace.workspaceId === concept.learnedWorkspaceId) ?? concept.memberships[0];
    return { concept, workspace: concept.memberships.map(workspace => workspace.workspaceName).join(', '), target: membership?.workspaceId };
  });
}

function transferTitles(graph: GlobalKnowledgeGraph) {
  const titles = new Map(graph.concepts.map(concept => [concept.id, concept.title]));
  const result = new Map<number, string[]>();
  for (const link of graph.links) {
    for (const [id, other] of [[link.fromConceptId, link.toConceptId], [link.toConceptId, link.fromConceptId]] as const) {
      const related = titles.get(other);
      if (!related) continue;
      const list = result.get(id) ?? [];
      list.push(related);
      result.set(id, list);
    }
  }
  return result;
}

function destination(key: string, index: number, count: number) {
  switch (key) {
    case 'ArrowDown': return Math.min(index + 1, count - 1);
    case 'ArrowUp': return Math.max(index - 1, 0);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return -1;
  }
}

function revealRow(list: HTMLDivElement, index: number) {
  const top = index * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

function useLearnedNavigation(rows: Row[], areaKey: string, positions: Map<string, number>) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(() => positions.get(areaKey) ?? 0);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const previousRows = useRef(rows);
  const pendingAction = useRef<RowAction | null>(null);
  const activeIndex = useMemo(() => {
    if (!anchor) return -1;
    const exact = rows.findIndex(row => row.concept.id === anchor.id && row.target === anchor.target);
    return exact >= 0 ? exact : rows.findIndex(row => row.concept.id === anchor.id);
  }, [rows, anchor]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) throw new Error('The learned list must have a scroll container.');
    list.scrollTop = positions.get(areaKey) ?? 0;
    setScroll(list.scrollTop);
    return () => { positions.set(areaKey, list.scrollTop); };
  }, [areaKey, positions]);

  useLayoutEffect(() => {
    if (previousRows.current === rows) return;
    previousRows.current = rows;
    const list = listRef.current;
    if (!list || activeIndex < 0) return;
    revealRow(list, activeIndex);
    setScroll(list.scrollTop);
  }, [rows, activeIndex]);

  useLayoutEffect(() => {
    const action = pendingAction.current;
    if (action === null) return;
    pendingAction.current = null;
    if (activeIndex < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row-index="${activeIndex}"]`);
    const select = row?.querySelector<HTMLButtonElement>('[data-action="select"]');
    if (!row || !select) throw new Error('The destination learned row must be mounted.');
    const button = action === 'lesson' ? row.querySelector<HTMLButtonElement>('[data-action="lesson"]') : select;
    (button ?? select).focus({ preventScroll: true });
  }, [anchor, activeIndex, scroll]);

  function navigate(event: KeyboardEvent<HTMLDivElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = destination(event.key, index, rows.length);
    const row = rows[next];
    const list = listRef.current;
    if (!row || !list || !(event.target instanceof HTMLButtonElement)) return;
    event.preventDefault();
    pendingAction.current = event.target.dataset.action === 'lesson' ? 'lesson' : 'select';
    revealRow(list, next);
    setScroll(list.scrollTop);
    setAnchor({ id: row.concept.id, target: row.target });
  }

  return { listRef, scroll, setScroll, activeIndex, setAnchor, navigate };
}

export function LearnedList({ graph, concepts, areaId, areaKey, positions, group, setGroup, onSelect, onOpen }: Props) {
  const rows = useMemo(() => learnedRows(concepts, group, areaId), [concepts, group, areaId]);
  const transfers = useMemo(() => transferTitles(graph), [graph]);
  const { listRef, scroll, setScroll, activeIndex, setAnchor, navigate } = useLearnedNavigation(rows, areaKey, positions);
  const firstVisible = Math.min(rows.length - 1, Math.floor(scroll / ROW_HEIGHT));
  const first = Math.max(0, firstVisible - 3);
  const entry = activeIndex >= first && activeIndex < first + MOUNTED_ROWS ? activeIndex : firstVisible;
  return <>
    <div className="knowledge-list-heading">
      <h2>Everything I’ve learned</h2>
      <label><input type="checkbox" checked={group} onChange={event => setGroup(event.target.checked)} /> Group by workspace</label>
    </div>
    <div className="knowledge-list" ref={listRef} onScroll={event => setScroll(event.currentTarget.scrollTop)}>
      <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
        {rows.slice(first, first + MOUNTED_ROWS).map(({ concept, workspace, target }, index) => {
          const rowIndex = first + index;
          const tabIndex = rowIndex === entry ? 0 : -1;
          const related = transfers.get(concept.id);
          return <div className="knowledge-list-row" key={`${concept.id}-${target}`} data-row-index={rowIndex}
            style={{ top: rowIndex * ROW_HEIGHT, height: ROW_HEIGHT }}
            onFocus={() => setAnchor(current => current?.id === concept.id && current.target === target ? current : { id: concept.id, target })}
            onKeyDown={event => navigate(event, rowIndex)}>
            <button className="knowledge-list-select" data-action="select" tabIndex={tabIndex} onClick={() => onSelect(concept.id)}>
              <strong>{concept.title}</strong>
              <span>{concept.masteredDepth} depth · {concept.learnedAt ? new Date(concept.learnedAt).toLocaleDateString() : 'Date unavailable'}
                {' · '}{workspace}{related?.length ? ` · Transfers: ${related.join(', ')}` : ''}</span>
            </button>
            {target && <button data-action="lesson" tabIndex={tabIndex}
              onClick={() => onOpen(target, concept.id, 'lesson', concept.masteredDepth ?? undefined)}
              aria-label={`Open lesson: ${concept.title}`}>Open lesson</button>}
          </div>;
        })}
      </div>
      {rows.length === 0 && <p>No understood concepts match these filters yet.</p>}
    </div>
  </>;
}
