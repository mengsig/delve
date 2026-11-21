import { useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import type { LessonBlock, ReaderMessage } from '../../../shared/reader';
import { EnvironmentActivity } from '../lab/EnvironmentActivity';
import { TeachingBlock } from './Blocks';
import type { useTutor } from './Tutor';

export function LessonBlocks({ blocks, animate }: { blocks: LessonBlock[]; animate: boolean }) {
  const [visible, setVisible] = useState(() => !animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? blocks.length : 1);
  useEffect(() => {
    if (visible >= blocks.length) return;
    const timer = window.setTimeout(() => setVisible(count => count + 1), 100);
    return () => window.clearTimeout(timer);
  }, [blocks.length, visible]);
  return <div className="lesson-blocks">{blocks.slice(0, visible).map((block, index) => block.type !== 'check'
    && <TeachingBlock key={index} block={block} blockIndex={index} />)}</div>;
}

function Message({ message }: { message: ReaderMessage }) {
  const label = message.role === 'learner' ? 'You' : message.role === 'tutor' ? 'Tutor' : 'Delve';
  return <div className={'reader-message reader-message-' + message.role}>
    <span className="eyebrow">{label}</span>
    {message.text && <p>{message.text}</p>}
    {message.blocks && <div className="lesson-blocks">{message.blocks.map((block, index) =>
      block.type !== 'check' && <TeachingBlock key={index} block={block} blockIndex={index} messageId={message.id} />)}</div>}
    {message.observation && <p className="reader-observation">{message.observation}</p>}
  </div>;
}

export function Conversation({ messages, earlierMessages }: { messages: ReaderMessage[]; earlierMessages: boolean }) {
  return <section className="reader-conversation">
    {earlierMessages && <p className="smallprint">Showing the latest saved messages.</p>}
    <div role="log" aria-label="Lesson conversation" aria-live="polite" aria-relevant="additions">
      {messages.map(message => <Message key={message.id} message={message} />)}
    </div>
  </section>;
}

export function Composer({ tutor, draft, setDraft, focusOnOpen }: {
  tutor: ReturnType<typeof useTutor>; draft: string; setDraft: (text: string) => void; focusOnOpen?: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const activity = useContext(EnvironmentActivity);
  useEffect(() => { if (focusOnOpen) input.current?.focus({ preventScroll: true }); }, [focusOnOpen]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || tutor.pending) return;
    activity?.onRead();
    tutor.prepare({ kind: 'ask', text: draft.trim() });
  }
  return <form className="reader-composer" onSubmit={submit}>
    <label className="eyebrow" htmlFor="reader-question">{tutor.provider === 'demo' ? 'Ask the demo tutor' : 'Ask your tutor'}</label>
    <textarea ref={input} id="reader-question" rows={1} maxLength={4000} placeholder="Ask a question or request a different example…"
      value={draft} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} />
    <div className="reader-composer-footer">
      <span className="smallprint">{tutor.provider === 'demo' ? 'Offline conversation · saved on this device' : 'Conversation saved on this device'}</span>
      <div className="actions">
        {tutor.provider !== 'demo' && draft.trim() && <button type="button" disabled={tutor.pending}
          onClick={() => tutor.prepare({ kind: 'ask', text: draft.trim() }, true)}>Preview</button>}
        <button type="submit" className="primary-btn" disabled={!draft.trim() || tutor.pending}>Ask question</button>
      </div>
    </div>
  </form>;
}
