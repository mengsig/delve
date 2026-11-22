import { useState } from 'react';
import type { ReaderMastery } from '../../../shared/reader';
import { useTutorJobs, type LessonDraft } from './TutorJobs';

export function useLessonDraft(scope: string, mastery: ReaderMastery, initialQuestion?: string) {
  const { drafts } = useTutorJobs();
  const [saved, setSaved] = useState<LessonDraft>(() => {
    const prior = drafts.get(scope) ?? { mode: 'answer', question: '', revision: mastery.revision, reasoning: '' };
    return initialQuestion ? { ...prior, mode: 'ask', question: prior.question || initialQuestion } : prior;
  });
  const draft = saved.revision === mastery.revision ? saved :
    { ...saved, choice: undefined, reasoning: '', revision: mastery.revision };

  function change(update: Partial<LessonDraft>) {
    const next = { ...draft, ...update };
    drafts.set(scope, next);
    setSaved(next);
  }

  return { draft, change };
}
