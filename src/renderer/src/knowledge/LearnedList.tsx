import { useMemo, useState } from 'react';
import type { GlobalKnowledgeGraph, KnowledgeConcept } from '../../../shared/knowledge';
import type { KnowledgeActions } from './Knowledge';

export function LearnedList({ graph, concepts, areaId, group, setGroup, onSelect, onOpen }: { graph: GlobalKnowledgeGraph; concepts: KnowledgeConcept[]; areaId: string; group: boolean; setGroup: (value: boolean) => void; onSelect: (id: number) => void; onOpen: KnowledgeActions['onOpen'] }) {
  const [scroll, setScroll] = useState(0);
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
  const rowHeight = 76; const first = Math.min(Math.max(0, rows.length - 1), Math.max(0, Math.floor(scroll / rowHeight) - 3)); const count = 15;
  return <><div className="knowledge-list-heading"><h2>Everything I’ve learned</h2><label><input type="checkbox" checked={group} onChange={e => setGroup(e.target.checked)} /> Group by workspace</label></div>
    <div className="knowledge-list" onScroll={e => setScroll(e.currentTarget.scrollTop)}><div style={{ height: rows.length * rowHeight, position: 'relative' }}>
      {rows.slice(first, first + count).map(({ concept, workspace, target }, index) => {
        return <div className="knowledge-list-row" key={`${concept.id}-${target}`} style={{ top: (first + index) * rowHeight, height: rowHeight }}>
          <button className="knowledge-list-select" onClick={() => onSelect(concept.id)}>
            <strong>{concept.title}</strong><span>{concept.masteredDepth} depth · {concept.learnedAt ? new Date(concept.learnedAt).toLocaleDateString() : 'Date unavailable'} · {workspace}{transfers.get(concept.id)?.length ? ` · Transfers: ${transfers.get(concept.id)!.join(', ')}` : ''}</span>
          </button>
          {target && <button onClick={() => onOpen(target, concept.id, 'lesson', concept.masteredDepth ?? undefined)} aria-label={`Open lesson: ${concept.title}`}>Open lesson</button>}
        </div>;
      })}</div>{!rows.length && <p>No understood concepts match these filters yet.</p>}</div></>;
}
