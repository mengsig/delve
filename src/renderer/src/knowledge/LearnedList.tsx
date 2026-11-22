import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { GlobalKnowledgeGraph, KnowledgeConcept } from '../../../shared/knowledge';
import type { KnowledgeActions } from './Knowledge';

const rowHeight = 76;
const mountedRows = 15;

export function LearnedList({ graph, concepts, areaId, group, setGroup, onSelect, onOpen }: { graph: GlobalKnowledgeGraph; concepts: KnowledgeConcept[]; areaId: string; group: boolean; setGroup: (value: boolean) => void; onSelect: (id: number) => void; onOpen: KnowledgeActions['onOpen'] }) {
  const [scroll, setScroll] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ id: number; target?: string } | null>(null);
  const rows = useMemo(() => {
    const sorted = [...concepts].sort((a, b) => (b.learnedAt ?? '').localeCompare(a.learnedAt ?? ''));
    return group ? sorted.flatMap(c => c.memberships.map(w => ({ concept: c, workspace: w.workspaceName, target: w.workspaceId }))).sort((a, b) => a.workspace.localeCompare(b.workspace))
      : sorted.map(concept => ({ concept, workspace: concept.memberships.map(w => w.workspaceName).join(', '), target: (concept.memberships.find(w => w.workspaceId === areaId)
        ?? concept.memberships.find(w => w.workspaceId === concept.learnedWorkspaceId) ?? concept.memberships[0])?.workspaceId }));
  }, [concepts, group, areaId]);
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
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !anchor.current) return;
    const { id, target } = anchor.current;
    let index = rows.findIndex(row => row.concept.id === id && row.target === target);
    if (index < 0) index = rows.findIndex(row => row.concept.id === id);
    if (index >= 0) list.scrollTop = index * rowHeight;
  }, [rows]);
  function navigate(event: KeyboardEvent<HTMLDivElement>, index: number) {
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1)
      : event.key === 'ArrowUp' ? Math.max(index - 1, 0)
        : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : -1;
    if (next < 0 || !listRef.current) return;
    event.preventDefault();
    const list = listRef.current;
    const action = (event.target as HTMLElement).classList.contains('knowledge-list-select') ? 'select' : 'lesson';
    const top = next * rowHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + rowHeight - list.clientHeight;
    setScroll(list.scrollTop);
    requestAnimationFrame(() => {
      const row = list.querySelector<HTMLElement>(`[data-row-index="${next}"]`);
      (row?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`) ?? row?.querySelector<HTMLButtonElement>('[data-action="select"]'))?.focus();
    });
  }
  const first = Math.min(Math.max(0, rows.length - 1), Math.max(0, Math.floor(scroll / rowHeight) - 3));
  return <><div className="knowledge-list-heading"><h2>Everything I’ve learned</h2><label><input type="checkbox" checked={group} onChange={e => setGroup(e.target.checked)} /> Group by workspace</label></div>
    <div className="knowledge-list" ref={listRef} onScroll={e => setScroll(e.currentTarget.scrollTop)}><div style={{ height: rows.length * rowHeight, position: 'relative' }}>
      {rows.slice(first, first + mountedRows).map(({ concept, workspace, target }, index) => {
        const rowIndex = first + index;
        return <div className="knowledge-list-row" key={`${concept.id}-${target}`} data-row-index={rowIndex} style={{ top: rowIndex * rowHeight, height: rowHeight }}
          onFocus={() => { anchor.current = { id: concept.id, target }; }} onKeyDown={e => navigate(e, rowIndex)}>
          <button className="knowledge-list-select" data-action="select" onClick={() => onSelect(concept.id)}>
            <strong>{concept.title}</strong><span>{concept.masteredDepth} depth · {concept.learnedAt ? new Date(concept.learnedAt).toLocaleDateString() : 'Date unavailable'} · {workspace}{transfers.get(concept.id)?.length ? ` · Transfers: ${transfers.get(concept.id)!.join(', ')}` : ''}</span>
          </button>
          {target && <button data-action="lesson" onClick={() => onOpen(target, concept.id, 'lesson', concept.masteredDepth ?? undefined)} aria-label={`Open lesson: ${concept.title}`}>Open lesson</button>}
        </div>;
      })}</div>{!rows.length && <p>No understood concepts match these filters yet.</p>}</div></>;
}
