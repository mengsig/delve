import { useEffect, useRef, useState } from 'react';
import type { LessonAddress, ReaderLesson } from '../../../shared/reader';
import { buildAtlas } from '../atlas/model';
import { call } from '../api';
import type { ReaderProps } from './ReaderHeader';
import { Check } from './Blocks';
import type { useTutor } from './Tutor';

type Mastery = ReaderLesson['mastery'];

export function LessonProgress({ props, mastery }: { props: ReaderProps & { conceptId: number }; mastery: Mastery }) {
  const model = buildAtlas(props.graph, props.depth);
  const path = model.layers.flat();
  const index = path.findIndex(concept => concept.id === props.conceptId);
  const stage = mastery.stage === 'checking' && mastery.attempts > 0 ? 'Reinforce'
    : { teaching: 'Explain', checking: 'Check', review: 'Reinforce', understood: 'Understood', skipped: 'Skipped' }[mastery.stage];
  const knownHere = model.byId.get(props.conceptId)?.evidence?.status === 'demonstrated';
  const learned = model.learned + (mastery.stage === 'understood' && !knownHere ? 1 : 0);
  return <div className="lesson-progress" aria-label="Lesson progress">
    <span>Lesson {index + 1} of {path.length}</span>
    <span>{learned} of {path.length} concepts understood</span>
    <strong>Now: {stage}</strong>
    <div className="lesson-stages" aria-label="Lesson stages">Explain → Check → Reinforce if needed → Understood → Lesson complete</div>
  </div>;
}

function Completion({ props, mastery, tutor }: {
  props: ReaderProps & { conceptId: number }; mastery: Mastery; tutor: ReturnType<typeof useTutor>;
}) {
  const model = buildAtlas(props.graph, props.depth);
  const path = model.layers.flat();
  const current = model.byId.get(props.conceptId);
  const eligible = (concept: (typeof path)[number]) => concept.id !== props.conceptId
    && concept.evidence?.status !== 'demonstrated'
    && concept.prerequisites.every(prior => prior.id === props.conceptId || prior.evidence?.status === 'demonstrated');
  const next = current?.dependents.find(eligible) ?? path.find(eligible);
  const index = path.findIndex(concept => concept.id === props.conceptId);
  const previous = current?.prerequisites[0] ?? path[index - 1];
  return <section className="chapter lesson-completion" aria-label="Lesson complete">
    <span className="eyebrow">Lesson complete</span>
    <h3>{mastery.stage === 'understood' ? 'You understand this concept' : 'Not understood yet'}</h3>
    <p>{mastery.stage === 'understood' ? current?.summary : 'This concept is not marked understood. You can return to its check anytime.'}</p>
    <div className="actions">
      {next && mastery.stage === 'understood' && <button className="primary-btn" onClick={() => props.onLesson(next.id)}>Next lesson: {next.title}</button>}
      <button className={mastery.stage === 'skipped' ? 'primary-btn' : undefined} disabled={tutor.pending || !mastery.revision} onClick={() => mastery.revision && tutor.prepare({ kind: 'review', revision: mastery.revision })}>{mastery.stage === 'skipped' ? 'Keep practising' : 'Review this lesson again'}</button>
      {previous && <button onClick={() => props.onLesson(previous.id)}>Go back to {previous.title}</button>}
      <button onClick={props.onBack}>Back to the map</button>
    </div>
    {next && mastery.stage === 'skipped' && <p><button className="lesson-move-on" onClick={() => props.onLesson(next.id)}>Move on anyway: {next.title}</button></p>}
    {next && mastery.stage === 'understood' && <p className="smallprint">Recommended next: {next.prerequisites.some(prior => prior.id === current?.id)
      ? `It builds on ${current?.title}. ` : 'It is ready to explore. '}{next.summary}</p>}
  </section>;
}

export function MasteryFlow({ body, address, props, tutor, onLesson }: {
  body: ReaderLesson; address: LessonAddress; props: ReaderProps & { conceptId: number };
  tutor: ReturnType<typeof useTutor>; onLesson: (lesson: ReaderLesson) => void;
}) {
  const [error, setError] = useState('');
  const [skipping, setSkipping] = useState(false);
  const mastery = body.mastery;
  const previousRevision = useRef(mastery.revision);
  useEffect(() => {
    if (previousRevision.current && previousRevision.current !== mastery.revision && mastery.stage === 'checking') {
      const messages = document.querySelectorAll('.reader-message-tutor');
      messages.item(messages.length - 1)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    previousRevision.current = mastery.revision;
  }, [mastery.revision, mastery.stage]);
  async function skip() {
    if (!mastery.revision || skipping) return;
    setError('');
    setSkipping(true);
    try { onLesson(await call('reader:skip', { ...address, revision: mastery.revision })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSkipping(false); }
  }
  if (mastery.stage === 'understood' || mastery.stage === 'skipped') return <Completion props={props} mastery={mastery} tutor={tutor} />;
  const check = mastery.activeCheck;
  const model = buildAtlas(props.graph, props.depth);
  const path = model.layers.flat();
  const previous = model.byId.get(props.conceptId)?.prerequisites[0]
    ?? path[path.findIndex(concept => concept.id === props.conceptId) - 1];
  return <>
    {check && mastery.revision && <Check key={mastery.revision} block={check.options
      ? { type: 'check', prompt: check.prompt, options: check.options }
      : { type: 'check', kind: 'short-answer', prompt: check.prompt }} pending={tutor.pending || skipping}
      onAnswer={answer => tutor.prepare({ kind: 'answer', revision: mastery.revision!, answer })}
      onPreview={props.graph.demo ? undefined : answer => tutor.prepare({ kind: 'answer', revision: mastery.revision!, answer }, true)} />}
    {(mastery.stage === 'review' || mastery.stage === 'teaching' && mastery.revision) && <section className="chapter lesson-pause">
      <h3>{mastery.stage === 'review' ? 'Let’s try a different approach' : 'Ready for a check?'}</h3>
      <p>{mastery.stage === 'review'
        ? 'We haven’t confirmed this concept yet. Try another check, ask for a different analogy or a visual, or go back to a prerequisite.'
        : 'Try a check to see how well the idea makes sense.'}</p>
      <div className="actions">
        <button disabled={tutor.pending || !mastery.revision} onClick={() => mastery.revision && tutor.prepare({ kind: 'review', revision: mastery.revision })}>Try another check</button>
        {mastery.stage === 'review' && <>
          {!props.graph.demo && <button disabled={tutor.pending} onClick={() => tutor.prepare({ kind: 'ask', text: 'Explain this using a different analogy.' })}>Try an analogy</button>}
          <button disabled={tutor.pending} onClick={() => tutor.prepare({ kind: 'ask', text: 'Show me a visual of this concept.' })}>Show a visual</button>
          {previous && <button onClick={() => props.onLesson(previous.id)}>Go back to {previous.title}</button>}
        </>}
      </div>
    </section>}
    {mastery.revision && <button disabled={tutor.pending || skipping} onClick={() => void skip()}>Skip this check</button>}
    {error && <p role="alert">Could not skip the check. {error}</p>}
  </>;
}
