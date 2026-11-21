import { DEPTHS } from '../../../shared/domain';
import { CodeExcerpt, Diagram } from './Blocks';
import { ReaderHeader, type ReaderProps } from './ReaderHeader';
import { demoBrief, demoGuardedWrite } from '../../../shared/reader-demo';
import './reader.css';

function Comparison() {
  return <section className="chapter">
    <span className="eyebrow">Before → after</span>
    <div className="grid2 reader-comparison">
      <div className="note"><strong>Before / task ID</strong><p>Either worker can publish a result for the same task.</p></div>
      <div className="note"><strong>After / active claim</strong><p>Only the current owner can make its result durable.</p></div>
    </div>
  </section>;
}

function EmptyChanges(props: ReaderProps & { onAdd: () => void }) {
  const { workspace, graph } = props;
  const topic = workspace.kind === 'topic';
  const summary = topic ? 'This topic has no Git history.'
    : graph.snapshot ? 'Only the snapshot is available. A saved diff is needed to explain the changes and their impact.'
    : 'There is no saved pull request or commit diff for this repository.';
  return <>
    <ReaderHeader {...props} label={'Change notes / ' + workspace.name} title="No change brief here." summary={summary} showDepth={false} />
    <button className="primary-btn" onClick={props.onAdd}>Add a repository</button>
    {!topic && graph.snapshot && <section className="sheet">
      <span className="eyebrow">Partial coverage</span><h3>Snapshot only</h3><p className="mono">{graph.snapshot}</p>
    </section>}
  </>;
}

export function DemoChanges(props: ReaderProps & { onAdd: () => void }) {
  const { workspace, graph, depth, onLesson } = props;
  const fence = graph.concepts.find(concept => concept.key.endsWith(':fence'));
  if (graph.workspaceId !== workspace.id || !graph.demo || graph.snapshot !== demoBrief.head || !fence) return <EmptyChanges {...props} />;
  return <>
    <ReaderHeader {...props} label={`Change brief / ${workspace.name} / PR #184 · fixture`}
      title="Reject late worker results." summary="One task, two owners, one late result. What should the daemon keep?" />
    <div className="actions demo-change-action"><button className="primary-btn" onClick={() => onLesson(fence.id)}>Teach me this change</button></div>
    <div className="reader reader-layout">
      <article className="sheet">
        {demoBrief.sections.slice(0, 2 + DEPTHS.indexOf(depth)).map(([heading, text]) =>
          <section key={heading} className="chapter"><h3>{heading}</h3><p>{text}</p></section>)}
        <Comparison />
        {depth !== 'high' && <Diagram nodes={['dispatch.rs', 'lease_store.rs', 'result_store.rs']} />}
        {depth === 'low' && <CodeExcerpt block={demoGuardedWrite} />}
      </article>
      <aside className="card">
        <span className="eyebrow">Change footprint</span><h3>{fence.title}</h3>
        <p>Review the repository-specific write rule that now rejects an expired claim.</p>
        <div className="impact"><span className="plate">Illustrative base → head</span><div className="mono mini">{demoBrief.base} → {graph.snapshot}</div></div>
      </aside>
    </div>
  </>;
}
