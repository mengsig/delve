import { useMemo } from 'react';
import { coversDepth, demonstratedEvidence } from '../../../shared/evidence-depth';
import { plainConceptTitle } from '../../../shared/plain-language';
import type { ReaderLesson } from '../../../shared/reader';
import { Meter } from '../design/Meter';
import { Icon } from '../Icon';
import { buildLearningProgress, eligibleNext } from '../progress/model';
import { ConceptMeter } from '../progress/ProgressMeters';
import { LessonStart } from './LessonStart';
import type { ReaderProps } from './ReaderHeader';
import type { LessonTutor } from './Tutor';

type Props = ReaderProps & { conceptId: number };
type Mastery = ReaderLesson['mastery'];

export function LessonRail({ props, mastery, title }: { props: Props; mastery: Mastery; title: string }) {
  const progress = useMemo(() => buildLearningProgress(props.graph, props.depth), [props.graph, props.depth]);
  const current = progress.byId.get(props.conceptId);
  const prerequisites = new Set(current?.prerequisites);
  const evidence = useMemo(() => demonstratedEvidence(props.graph.evidence), [props.graph.evidence]);
  const mastered = mastery.stage === 'understood';
  return <aside className="lesson-rail" aria-label="Lesson progress">
    <header className="current-lesson"><span className="plate">Current lesson</span><strong>{title}</strong>
      <Meter label="Correct checks in a row" value={Math.min(mastery.correctAnswers, mastery.requiredCorrectAnswers)} max={mastery.requiredCorrectAnswers}
        detail={mastery.correctAnswers > mastery.requiredCorrectAnswers ? mastery.correctAnswers + ' in a row · target ' + mastery.requiredCorrectAnswers : undefined} />
      <small>{mastered ? '✓ Verified mastery' : mastery.appliedPassed ? '✓ Application passed' : 'Includes one application check'}</small>
    </header>
    <div className="path-heading"><b>Your learning path</b><span>{progress.available ? progress.mastered + ' / ' + progress.total + ' mastered' : 'Progress unavailable'}</span></div>
    <ul className="path-concepts" aria-label="Concept mastery">
      {progress.available && progress.concepts.filter(c => c.onAtlas || c.id === props.conceptId || prerequisites.has(c.id)).map(c => {
        const proof = evidence.get(c.id);
        const goDeeper = proof && !coversDepth(proof.depth, props.depth);
        return <li key={c.id} className={c.id === current?.id ? 'active-concept' : undefined} data-state={c.state}>
          <span className="path-symbol" aria-hidden="true">{c.state === 'mastered' ? <Icon name="check" /> :
            c.id === current?.id ? '◎' : c.state === 'locked' ? <Icon name="lock" /> : c.state === 'in-progress' ? '◒' : ''}</span>
          <div className="path-progress"><ConceptMeter concept={c} current={c.id === current?.id} />
            {prerequisites.has(c.id) && <button className="back" onClick={() => props.onLesson(c.id)}>
              {goDeeper ? 'Go deeper on ' : 'Open '}{c.title}
            </button>}</div></li>;
      })}
    </ul>
    <button className="progress-link" onClick={props.onProgress}><Icon name="layer" /> Progress at {props.depth} depth</button>
  </aside>;
}

export function Completion({ props, mastery, tutor, title }: { props: Props; mastery: Mastery; tutor: LessonTutor; title: string }) {
  const progress = useMemo(() => buildLearningProgress(props.graph, props.depth), [props.graph, props.depth]);
  const next = progress.available && eligibleNext(progress, props.conceptId);
  return <section className="lesson-completion" aria-label="Lesson complete">
    <span className="mastery-seal" aria-hidden="true"><Icon name="check" /></span>
    <div><span className="plate">Lesson complete</span><h3>{title} mastered</h3>
      <p>{mastery.appliedPassed ? 'Your correct checks included a new situation.' : 'Verified at ' + props.depth + ' depth.'}</p></div>
    {next ? <LessonStart workspaceId={props.workspace.id} conceptId={next.id} depth={props.depth} provider={tutor.provider} signedIn={tutor.signedIn}
      title={next.title} open={props.onLesson} /> : <button className="primary-btn" onClick={props.onProgress}>View progress</button>}
  </section>;
}

export function Practice({ props, mastery, tutor }: { props: Props; mastery: Mastery; tutor: LessonTutor }) {
  const dependent = props.graph.edges.find(edge => edge.prerequisiteId === props.conceptId);
  const next = props.graph.concepts.find(node => node.id === dependent?.conceptId);
  const title = next && (props.depth === 'high' ? plainConceptTitle(next.title) : next.title);
  return <section className="lesson-practice" aria-label="Practice paused"><h3>Practice paused</h3>
    <p>{mastery.stage === 'skipped' ? 'You skipped this check.' : 'You’ve used the attempts for this round.'} Start another round to practise this concept.</p>
    <button className="primary-btn" disabled={tutor.pending || !tutor.signedIn || !mastery.revision}
      onClick={() => mastery.revision && tutor.prepare({ kind: 'review', revision: mastery.revision })}>Keep practising</button>
    {next && mastery.stage === 'skipped' && <button className="lesson-move-on" onClick={() => props.onLesson(next.id)}>Move on anyway: {title}</button>}
  </section>;
}
