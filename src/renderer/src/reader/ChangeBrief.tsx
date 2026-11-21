import type { ChangeBrief } from '../../../shared/repository';
import { CodeExcerpt, Diagram } from './Blocks';

export function BriefChapters({ brief }: { brief: ChangeBrief }) {
  return <article className="sheet" aria-label="Change brief">
    <section className="chapter"><h3>What changed</h3><p>{brief.what}</p></section>
    <section className="chapter"><h3>Why it matters</h3><p>{brief.why}</p></section>
    {brief.mechanics && <section className="chapter"><h3>How it works</h3><p>{brief.mechanics}</p></section>}
    {brief.boundary && <section className="chapter"><h3>Protocol edge</h3><p>{brief.boundary}</p></section>}
    <section className="chapter">
      <span className="eyebrow">Before → after</span>
      <div className="grid2 reader-comparison">
        <div className="note"><strong>Before</strong><p>{brief.before}</p></div>
        <div className="note"><strong>After</strong><p>{brief.after}</p></div>
      </div>
    </section>
    {brief.trace.length > 0 && <Diagram nodes={brief.trace} />}
    {brief.excerpt.length > 0 && <CodeExcerpt block={{ type: 'code', source: 'Approved diff', lines: brief.excerpt }} />}
    {brief.partial && <p className="repository-notice" role="status">Partial coverage. {brief.coverageNote ?? 'This brief uses the available portion of the diff.'}</p>}
  </article>;
}

interface Props {
  brief: ChangeBrief;
  onLesson: (id: number) => void;
  onFollowUp: (id: number) => void;
}

export function ChangeFootprint({ brief, onLesson, onFollowUp }: Props) {
  const { conceptId, reason } = brief.recommendation;
  const target = brief.touched.find(concept => concept.id === conceptId);
  return <aside className="card" aria-label="Change footprint">
    <span className="eyebrow">Change footprint</span><h3>{target?.title ?? brief.title}</h3>
    <p>{reason}</p>
    <div className="impact"><span className="plate">{brief.base ? 'Base → head' : 'Source revision'}</span><div className="mono mini repository-ref" title={[brief.base, brief.commit].filter(Boolean).join(' → ')}>{[brief.base, brief.commit].filter(Boolean).map(sha => sha?.slice(0, 12)).join(' → ')}</div></div>
    <div className="impact"><button className="primary-btn" onClick={() => target ? onLesson(conceptId) : onFollowUp(brief.conceptId)}>
      {target ? 'Explore this concept →' : 'Ask about this change →'}
    </button></div>
    {target && <div className="impact"><button className="back" onClick={() => onFollowUp(brief.conceptId)}>Ask about this change →</button></div>}
    {brief.touched.length > 0 && <details className="impact"><summary>Concepts touched ({brief.touched.length})</summary>
      <ul>{brief.touched.map(c => <li key={c.id}><button onClick={() => onLesson(c.id)}>{c.title}</button></li>)}</ul></details>}
    {brief.files.length > 0 && <details className="impact"><summary>Files in this brief ({brief.files.length})</summary>
      <ul>{brief.files.map(path => <li key={path}>{path}</li>)}</ul></details>}
  </aside>;
}
