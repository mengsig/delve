import { DEPTHS, type Depth } from '../../../shared/domain';
import type { ChangeBrief } from '../../../shared/repository';
import { BriefChapters } from '../reader/ChangeBrief';
import { ProviderReview } from '../repository/ProviderReview';
import { SetupProvider } from '../SetupProvider';
import type { LessonState } from './useChangeLesson';

const depthDescriptions = { high: 'What & why', medium: 'Module mechanics', low: 'Protocol detail' };

export function ReadingDepth({ depth, onDepth }: { depth: Depth; onDepth: (depth: Depth) => void }) {
  return <label className="explorer-depth"><span className="plate">Reading depth</span>
    <select value={depth} onChange={event => { const next = DEPTHS.find(d => d === event.target.value); if (next) onDepth(next); }}>
      {DEPTHS.map(value => <option key={value} value={value}>{value[0]?.toUpperCase()}{value.slice(1)} · {depthDescriptions[value]}</option>)}
    </select>
  </label>;
}

function Recommendation({ brief, onLesson }: { brief: ChangeBrief; onLesson: (id: number) => void }) {
  const { title, reason, conceptId } = brief.recommendation;
  return <aside className="change-next"><span className="eyebrow">Suggested next step</span>
    <h3>{title}</h3><p>{reason}</p>
    <button className="back" onClick={() => onLesson(conceptId)}>{conceptId === brief.conceptId ? 'Discuss this change' : 'Explore this concept'} →</button>
  </aside>;
}

interface Props {
  brief?: ChangeBrief;
  stale: boolean;
  description?: string;
  lesson: LessonState;
  depth: Depth;
  onLesson: (id: number) => void;
  teaching: boolean;
  onBack: () => void;
}

export function ChangeExplanation({ brief, stale, description, lesson, depth, onLesson, teaching, onBack }: Props) {
  const { saved, generation, running, locked, inspect, provider, chooseProvider } = lesson;
  const hasReview = Boolean(generation.preview || generation.pending);
  return <>
    {teaching && <div className="lesson-start"><button className="back" onClick={onBack}>← Back to explanation</button>
      <h3>Learn this change</h3><p>Review the source below to start your {depth}-depth lesson.</p></div>}
    {stale && <p className="repository-notice" role="status">This pull request has changed since its last explanation. Generate a brief for the current revision.</p>}
    {saved.result.status === 'loading' && <p role="status">Looking for a saved brief…</p>}
    {saved.result.status === 'error' && <div className="repository-notice"><p role="alert">{saved.result.message}</p>
      <button onClick={saved.refresh}>Retry saved brief</button></div>}
    {brief ? <><p className="brief-summary">{brief.summary}</p><p className="smallprint">Saved brief · available offline</p>
      <BriefChapters brief={brief} /><Recommendation brief={brief} onLesson={onLesson} /></>
      : !teaching && saved.result.status === 'ready' && <div className="explanation-start">
        <h3>{description ? 'From the author' : 'What changed and why'}</h3>
        <p>{description || 'Generate an explanation of the changes, the reasoning behind them, and the concepts they touch.'}</p>
      </div>}
    <div className="brief-tools">
      {!hasReview && <button disabled={locked} onClick={() => void inspect()}>
        {running ? 'Generating explanation…' : brief ? 'Refresh explanation' : generation.error ? 'Retry diff preview' : 'Preview diff request'}
      </button>}
      <details className="brief-provider" open={generation.error?.action === 'provider' || undefined}>
        <summary>Provider · {provider === 'codex' ? 'Codex' : 'Claude Code'}</summary>
        <SetupProvider label="Brief provider" disabled={locked} provider={provider} onChange={chooseProvider} />
      </details>
    </div>
    <ProviderReview generation={generation} provider={provider} depth={depth} workflow="explain" disabled={running} />
  </>;
}

export function ChangeConcepts({ brief, atlasIds, onAtlas, onExplain }: {
  brief?: ChangeBrief; atlasIds: Set<number>; onAtlas: (id: number) => void; onExplain: () => void;
}) {
  if (!brief) return <div className="panel-message"><h3>Concepts touched</h3>
    <p>Generate the explanation to identify the concepts in this change.</p><button onClick={onExplain}>Explain this change</button></div>;
  if (!brief.touched.length) return <p className="panel-message">The explanation identified no directly affected concepts.</p>;
  return <ul className="concept-footprint">{brief.touched.map(concept => {
    const onMap = atlasIds.has(concept.id);
    return <li key={concept.id}><div><strong>{concept.title}</strong><small>{onMap ? 'On your repository atlas' : 'Introduced in this change'}</small></div>
      <button onClick={() => onAtlas(concept.id)}>View on Atlas ↗</button></li>;
  })}</ul>;
}
