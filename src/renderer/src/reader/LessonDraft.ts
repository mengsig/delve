import { useState } from 'react';
import type { ReaderMastery, TutorIntent } from '../../../shared/reader';
import { useTutorJobs, type LessonDraft } from './TutorJobs';

export function useLessonDraft(scope: string, mastery: ReaderMastery, initialQuestion?: string, submitted?: TutorIntent) {
  const { drafts } = useTutorJobs();
  const [saved, setSaved] = useState(() => {
    const prior = drafts.get(scope);
    return prior && initialQuestion ? { ...prior, mode: 'ask' as const, question: prior.question || initialQuestion } : prior;
  });
  const answer = submitted?.kind === 'answer' && submitted.revision === mastery.revision ? submitted : undefined;
  const prior: LessonDraft = saved ?? { mode: initialQuestion ? 'ask' : 'answer', question: initialQuestion ?? '',
    revision: mastery.revision, choice: typeof answer?.answer === 'number' ? answer.answer : undefined, reasoning: answer?.reasoning ?? '' };
  const draft = prior.revision === mastery.revision ? prior :
    { ...prior, choice: undefined, reasoning: '', revision: mastery.revision };

  function change(update: Partial<LessonDraft>) {
    const next = { ...draft, ...update };
    drafts.set(scope, next);
    setSaved(next);
  }

  return { draft, change };
}
