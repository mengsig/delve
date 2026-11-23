import { useCallback, useEffect, useRef, useState } from 'react';
import { DEPTHS, type Depth } from '../../../shared/domain';
import type { LessonAddress } from '../../../shared/reader';
import type { ChangeBrief } from '../../../shared/repository';
import { BriefChapters } from '../reader/ChangeBrief';
import { FoundationActivity } from '../reader/FoundationActivity';
import { SetupProvider } from '../SetupProvider';
import { call } from '../api';
import { useRead } from '../useRead';
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

function SavedBrief({ brief, address, onLesson, onEvidence }: {
  brief: ChangeBrief; address: LessonAddress; onLesson: (id: number) => void; onEvidence: () => void;
}) {
  const { workspaceId, conceptId, depth } = address;
  const lessonId = brief.lessonId;
  const read = useCallback(() => lessonId === undefined ? Promise.resolve({ step: null })
    : call('reader:foundation', { workspaceId, conceptId, depth, lessonId }), [workspaceId, conceptId, depth, lessonId]);
  const { result, refresh } = useRead(read);
  const [completion, setCompletion] = useState<{ feedback?: string }>();
  const summary = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (completion) summary.current?.focus(); }, [completion]);
  if (result.status === 'loading') return <p role="status">Opening the change lesson…</p>;
  if (result.status === 'error') return <p role="alert">{result.message} <button onClick={refresh}>Retry opening the lesson</button></p>;
  if (!completion && result.value.step) return <FoundationActivity address={{ ...address, lessonId }} initial={result.value.step}
    onComplete={feedback => { setCompletion({ feedback }); onEvidence(); }} />;
  return <>
    {completion?.feedback && <p role="status" className="reader-observation">{completion.feedback}</p>}
    <p ref={summary} tabIndex={-1} className="brief-summary">{brief.summary}</p><p className="smallprint">Saved brief · available offline</p>
    <BriefChapters brief={brief} /><Recommendation brief={brief} onLesson={onLesson} />
  </>;
}

export function ChangeExplanation({ description, lesson, workspaceId, depth, onLesson, onEvidence }: {
  description?: string; lesson: LessonState; workspaceId: string; depth: Depth; onLesson: (id: number) => void; onEvidence: () => void;
}) {
  const { brief, stale, running, provider, chooseProvider } = lesson;
  return <>
    {stale && <p className="repository-notice" role="status">This pull request has changed since its last explanation. Generate a brief for the current revision.</p>}
    {brief ? <SavedBrief key={[workspaceId, brief.conceptId, depth, brief.lessonId].join('/')} brief={brief}
      address={{ workspaceId, conceptId: brief.conceptId, depth }} onLesson={onLesson} onEvidence={onEvidence} />
      : <div className="explanation-start">
        <h3>{description ? 'From the author' : 'What changed and why'}</h3>
        <p>{description || 'Generate a lesson to see what changed, why it matters, and the concepts it touches.'}</p>
      </div>}
    <div className="brief-tools">
      <details className="brief-provider" open={(lesson.job?.phase === 'failed' && lesson.job.failure.action === 'provider') || undefined}>
        <summary>Provider · {provider === 'codex' ? 'Codex' : 'Claude Code'}</summary>
        <SetupProvider label="Brief provider" disabled={running} provider={provider} onChange={chooseProvider} />
      </details>
    </div>
  </>;
}

export function ChangeConcepts({ brief, atlasIds, onAtlas }: {
  brief?: ChangeBrief; atlasIds: Set<number>; onAtlas: (id: number) => void;
}) {
  if (!brief) return <div className="panel-message"><h3>Concepts touched</h3>
    <p>Use “Teach me this change” to see which concepts the diff affects.</p></div>;
  if (!brief.touched.length) return <p className="panel-message">The explanation identified no directly affected concepts.</p>;
  return <ul className="concept-footprint">{brief.touched.map(concept => {
    const onMap = atlasIds.has(concept.id);
    return <li key={concept.id}><div><strong>{concept.title}</strong><small>{onMap ? 'On your repository atlas' : 'Introduced in this change'}</small></div>
      <button onClick={() => onAtlas(concept.id)}>View on Atlas ↗</button></li>;
  })}</ul>;
}
