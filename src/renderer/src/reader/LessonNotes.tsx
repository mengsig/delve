import { useRef } from 'react';
import type { ReaderLesson } from '../../../shared/reader';
import { DEPTHS } from '../../../shared/domain';
import { coversDepth, demonstratedEvidence } from '../../../shared/evidence-depth';
import { Icon } from '../Icon';
import { LatestInstrumentLink } from '../lab/Environment';
import { TutorSettings, type LessonTutor } from './Tutor';
import type { ReaderProps } from './ReaderHeader';

interface NotesProps {
  props: ReaderProps & { conceptId: number };
  body: ReaderLesson;
  tutor: LessonTutor;
  skip: () => void;
  review: () => void;
  busy: boolean;
}

export function LessonNotes({ props, body, tutor, skip, review, busy }: NotesProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const concept = props.graph.concepts.find(c => c.id === props.conceptId);
  const evidence = demonstratedEvidence(props.graph.evidence.filter(e => e.conceptId === props.conceptId
    && (e.depth === props.depth || concept?.portable && coversDepth(e.depth, props.depth)))).get(props.conceptId);
  const mastery = body.mastery;
  function closeAnd(act: () => void) {
    dialog.current?.close();
    act();
  }
  return <>
    <button className="lesson-notes-button" onClick={() => dialog.current?.showModal()}><Icon name="book" /> Lesson notes</button>
    <dialog ref={dialog} className="reader-preview lesson-notes" aria-labelledby="lesson-notes-heading">
      <div className="notes-title"><h2 id="lesson-notes-heading">Lesson notes</h2><form method="dialog"><button autoFocus>Close</button></form></div>
      <p>{concept?.summary}</p>
      <section><h3>Source {props.workspace.kind === 'topic' ? 'study' : 'snapshot'}</h3><p className="mono">{body.source ?? 'No source recorded'}{props.graph.demo && ' · demo'}</p>
        <p>{evidence ? 'Understood at ' + evidence.depth + ' depth' +
          (evidence.workspaceName ? ' in ' + evidence.workspaceName : '') + '.' : 'Not yet marked understood at ' + props.depth + ' depth.'}</p></section>
      <section><h3>Tutor settings</h3><TutorSettings tutor={tutor} /></section>
      <section className="actions">
        <LatestInstrumentLink body={body} onOpen={() => dialog.current?.close()} />
        {mastery.revision && mastery.stage === 'understood' && <button disabled={busy} onClick={() => closeAnd(review)}>Review this lesson again</button>}
        {mastery.revision && ['teaching', 'checking', 'review'].includes(mastery.stage) && <button disabled={busy} onClick={() => closeAnd(skip)}>Skip this check</button>}
      </section>
    </dialog>
  </>;
}

export function LessonHeading({ props, title, children }: { props: ReaderProps & { onBackToChange?: () => void }; title: string; children?: React.ReactNode }) {
  return <header className="lesson-heading">
    <div className="lesson-breadcrumb"><button onClick={props.onBackToChange ?? props.onBack}>
      {props.onBackToChange ? '← Back to change brief' : props.backLabel ?? '← Back to atlas'}</button> <span>/</span> Study · Lesson</div>
    <h1>{title}</h1>
    <div className="lesson-tools"><label className="depth-picker"><Icon name="layer" />
      <select aria-label="Reading depth" value={props.depth} onChange={event => {
        const depth = DEPTHS.find(d => d === event.target.value);
        if (depth) props.onDepth(depth);
      }}>{DEPTHS.map(depth => <option key={depth} value={depth}>{depth[0]!.toUpperCase() + depth.slice(1)} depth</option>)}</select>
    </label>{children}</div>
  </header>;
}
