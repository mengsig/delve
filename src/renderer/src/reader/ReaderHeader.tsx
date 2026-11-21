import { DEPTHS, type Depth, type Workspace } from '../../../shared/domain';
import type { WorkspaceGraph } from '../../../shared/graph';

export interface ReaderProps {
  workspace: Workspace;
  graph: WorkspaceGraph;
  depth: Depth;
  onDepth: (depth: Depth) => void;
  onBack: () => void;
  onLesson: (id: number) => void;
  view: 'contour' | 'folio';
}

interface HeaderProps extends Pick<ReaderProps, 'depth' | 'onDepth' | 'onBack' | 'workspace'> {
  label: string;
  title: string;
  summary: string;
  showDepth?: boolean;
}

export function ReaderHeader({ depth, onDepth, onBack, workspace, label, title, summary, showDepth = true }: HeaderProps) {
  const scopes = workspace.kind === 'topic' ? ['Intent', 'Technique', 'Settings'] : ['What & why', 'Module mechanics', 'Protocol detail'];
  return <>
    <button className="back" onClick={onBack}>← Back to atlas</button>
    <header className="intro">
      <span className="eyebrow">{label}</span>
      <h1>{title}</h1>
      {summary && <p>{summary}</p>}
    </header>
    {showDepth && <div className="toolrow">
      <span className="plate">Reading depth</span>
      <div className="seg" role="group" aria-label="Reading depth">
        {DEPTHS.map((value, index) => <button key={value} aria-pressed={depth === value} onClick={() => onDepth(value)}>
          {value[0]?.toUpperCase()}{value.slice(1)} · {scopes[index]}
        </button>)}
      </div>
    </div>}
  </>;
}
