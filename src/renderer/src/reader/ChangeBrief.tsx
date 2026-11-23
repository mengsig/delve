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
    {brief.example && <section className="chapter"><h3>A simple example</h3><p>{brief.example}</p></section>}
    {brief.trace.length > 0 && <Diagram nodes={brief.trace} />}
    {brief.excerpt.length > 0 && <CodeExcerpt block={{ type: 'code', source: 'Approved diff', lines: brief.excerpt }} />}
    {brief.partial && <details className="repository-notice"><summary>Evidence</summary>
      <p>Partial coverage. {brief.coverageNote ?? 'This brief uses the available portion of the diff.'}</p></details>}
  </article>;
}
