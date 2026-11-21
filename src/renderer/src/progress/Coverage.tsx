import { DEPTHS, type Workspace } from '../../../shared/domain';
import type { WorkspaceCoverage } from '../../../shared/graph';

interface CoverageProps {
  workspaces: Workspace[];
  rows: WorkspaceCoverage[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function Coverage({ workspaces, rows, activeId, onSelect }: CoverageProps) {
  const byWorkspace = new Map(rows.map(row => [row.workspaceId, row]));
  return <div className="sheet coverage">
    <table>
      <caption className="sr-only">Concepts demonstrated at each reading depth</caption>
      <thead><tr><th scope="col">Workspace</th>{DEPTHS.map(depth => <th key={depth} scope="col">{depth}</th>)}</tr></thead>
      <tbody>{workspaces.map(workspace => {
        const row = byWorkspace.get(workspace.id);
        return <tr key={workspace.id}>
          <th scope="row"><button aria-pressed={workspace.id === activeId} onClick={() => onSelect(workspace.id)}>
            {workspace.name} ↗
          </button></th>
          {DEPTHS.map(depth => {
            if (!row) return <td key={depth}>Unavailable</td>;
            const percent = row.total ? Math.round(100 * row.known[depth] / row.total) : 0;
            return <td key={depth}>
              <b>{row.known[depth]} / {row.total}</b>
              <meter aria-label={`${workspace.name}, ${depth} depth coverage`} min={0} max={100} value={percent} />
              <small>{percent}% covered</small>
            </td>;
          })}
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
