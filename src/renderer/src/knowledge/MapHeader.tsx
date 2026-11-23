import type { Depth } from '../../../shared/domain';
import type { KnowledgeMembership } from '../../../shared/knowledge';
import { Icon } from '../Icon';
import { anyWorkspace } from './view';

export function MapHeading({ back, backLabel, demo, depth, onDepth, finder, toggleFinder }: {
  back: () => void; backLabel?: string; demo: boolean; depth: Depth; onDepth: (depth: Depth) => void; finder: boolean; toggleFinder?: () => void;
}) {
  return <header className="knowledge-heading">
    <div className="knowledge-breadcrumb"><button onClick={back}>{backLabel ?? '← Back'}</button><span>/</span>{demo ? 'Demo maps' : 'Knowledge · All workspaces'}</div>
    <div className="knowledge-title-row"><div><h1>Knowledge map</h1><p>Follow the connections to see what you can learn next.</p></div>
      <div className="knowledge-tools">
        <label><Icon name="layer" /><select aria-label="Learning depth" value={depth} onChange={e => onDepth(e.target.value as Depth)}>
          <option value="high">High-level depth</option><option value="medium">Medium depth</option><option value="low">Deep detail</option>
        </select></label>
        {toggleFinder && <button aria-expanded={finder} onClick={toggleFinder}><Icon name="knowledge" /> Find a concept</button>}
      </div></div>
  </header>;
}

export function AreaBar({ workspace, workspaces, count, onArea, list, toggleList }: {
  workspace: string; workspaces: KnowledgeMembership[]; count: number; onArea: (id: string) => void;
  list: boolean; toggleList: () => void;
}) {
  return <header className="knowledge-area-bar"><label><Icon name="atlas" />
    <select aria-label="Workspace area" value={workspace} onChange={e => onArea(e.target.value)}>
      <option value={anyWorkspace}>All workspaces</option>
      {workspaces.map(w => <option key={w.workspaceId} value={w.workspaceId}>{w.workspaceName}</option>)}
    </select></label>
    <span>{count} {count === 1 ? 'concept' : 'concepts'}</span>
    <button onClick={toggleList} aria-pressed={list}><Icon name={list ? 'atlas' : 'book'} />
      {list ? 'Show map' : 'Learned list'}</button>
  </header>;
}

export function Legend({ transfers }: { transfers: boolean }) {
  return <div className="knowledge-legend" aria-label="Map legend">
    <span><i className="mastered"><Icon name="check" /></i>Mastered</span><span><i className="underway">◎</i>In progress</span>
    <span><i />Ready</span><span><i className="locked"><Icon name="lock" /></i>Locked</span>
    <div className="knowledge-path-key"><span><b aria-hidden="true" />Known prerequisite</span>
      <span><b className="future" aria-hidden="true" />Ahead</span>
      {transfers && <span><b className="transfer" aria-hidden="true" />Transfer</span>}</div>
  </div>;
}
