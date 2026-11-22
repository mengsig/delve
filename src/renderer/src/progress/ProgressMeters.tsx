import { Meter } from '../design/Meter';
import type { ConceptProgress, LearningProgress } from './model';

export function WorkspaceMeter({ progress, label = `Workspace mastery · ${progress?.depth ?? ''} depth` }: {
  progress?: LearningProgress; label?: string;
}) {
  if (!progress?.available) return <span className="progress-unavailable">Progress unavailable</span>;
  return <Meter label={label} value={progress.mastered} max={progress.total} />;
}

export function ConceptMeter({ concept, current }: { concept: ConceptProgress; current?: boolean }) {
  const { target } = concept;
  const legacy = concept.state === 'in-progress' && concept.streak === null;
  const value = concept.state === 'mastered' ? target : Math.min(concept.streak ?? 0, target - 1);
  const status = current ? 'Current' : concept.unmet.length ? 'Locked' : 'Ready';
  const detail = concept.state === 'mastered' ? '✓ Mastered'
    : concept.state === 'in-progress' ? legacy ? 'In progress' : `${concept.streak} / ${target} in a row · ${status}` : status;
  return <Meter label={concept.title} value={value} max={target} detail={detail} tone={concept.state} hatched={legacy} />;
}
