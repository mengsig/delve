import { useContext, useEffect, useEffectEvent, useRef } from 'react';
import { CHECK_ANSWER_LIMIT } from '../../../shared/lesson-blocks';
import type { ActiveMasteryCheck, TutorIntent } from '../../../shared/reader';
import { EnvironmentActivity } from '../lab/EnvironmentActivity';
import type { LessonDraft } from './TutorJobs';

interface Props {
  check: ActiveMasteryCheck;
  revision: string;
  draft: LessonDraft;
  change: (update: Partial<LessonDraft>) => void;
  disabled: boolean;
  preview: boolean;
  submit: (intent: TutorIntent, exact?: boolean) => void;
}

export function AnswerCheck({ check, revision, draft, change, disabled, submit, preview }: Props) {
  const activity = useContext(EnvironmentActivity);
  const options = check.options ?? [];
  const group = useRef<HTMLDivElement>(null);
  const selected = draft.choice;
  function send(exact = false) {
    if (disabled || selected === undefined || options[selected] === undefined) return;
    activity?.onRead();
    const reasoning = draft.reasoning;
    submit({ kind: 'answer', revision, answer: selected, ...(reasoning.trim() && { reasoning }) }, exact);
  }
  const hotkey = useEffectEvent((event: KeyboardEvent) => {
    if (disabled || event.defaultPrevented || event.isComposing || event.repeat ||
      event.altKey || event.ctrlKey || event.metaKey || document.querySelector('dialog[open], [aria-modal="true"]')) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('textarea,input,select'))) return;
    if (/^[1-4]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (options[index] === undefined) return;
      event.preventDefault();
      change({ choice: index });
      group.current?.querySelectorAll('button')[index]?.focus({ preventScroll: true });
    } else if (event.key === 'Enter' && selected !== undefined && target instanceof Node && group.current?.contains(target)) {
      event.preventDefault();
      send();
    }
  });
  useEffect(() => {
    const handle = (event: KeyboardEvent) => hotkey(event);
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);
  return <form id="checkpoint" className="answer-check" onSubmit={event => { event.preventDefault(); send(); }}>
    <div className="choice-scroll"><h3 id="check-prompt">{check.prompt}</h3>
      <div ref={group} className="answer-options" role="group" aria-labelledby="check-prompt">
        {options.map((option, index) => <button type="button" key={index} disabled={disabled}
          aria-pressed={selected === index} onClick={() => change({ choice: index })}>
          <kbd aria-hidden="true">{index + 1}</kbd>{option}</button>)}
      </div>
    </div>
    <div className="reason-row"><label htmlFor="check-reason">Explain your reasoning <small>· optional</small></label>
      {preview && <button className="quiet" type="button" disabled={disabled || selected === undefined} onClick={() => send(true)}>Preview answer</button>}
      <textarea id="check-reason" rows={1} maxLength={CHECK_ANSWER_LIMIT} value={draft.reasoning}
        placeholder="What led you to that answer?" onChange={event => change({ reasoning: event.target.value })}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
          }
        }} />
      <button className="primary-btn" disabled={disabled || selected === undefined}>Check answer <span aria-hidden="true">→</span></button>
    </div>
  </form>;
}
