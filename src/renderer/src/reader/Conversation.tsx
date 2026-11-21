import { useState, type FormEvent } from 'react';
import type { LessonAddress, ReaderMessage } from '../../../shared/reader';
import { call } from '../api';

interface ConversationProps {
  address: LessonAddress;
  demo: boolean;
  messages: ReaderMessage[];
  earlierMessages: boolean;
}

function Message({ message }: { message: ReaderMessage }) {
  const label = message.role === 'learner' ? 'You' : message.role === 'tutor' ? 'Tutor' : 'Delve';
  return <div className={'reader-message reader-message-' + message.role}>
    <span className="eyebrow">{label}</span>
    <p>{message.text}</p>
  </div>;
}

export function Conversation({ address, demo, messages, earlierMessages }: ConversationProps) {
  const [added, setAdded] = useState<ReaderMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const savedIds = new Set(messages.map(message => message.id));
  const transcript = [...messages, ...added.filter(message => !savedIds.has(message.id))];
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pending) return;
    setPending(true);
    setError('');
    try {
      const reply = await call('reader:message', { ...address, text });
      setAdded(previous => [...previous, ...reply]);
      setDraft('');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }
  return <section className="chapter reader-conversation">
    <h3>Conversation</h3>
    {earlierMessages && <p className="smallprint">Showing the latest saved messages.</p>}
    <div role="log" aria-label="Lesson conversation" aria-live="polite" aria-relevant="additions">
      {transcript.map(message => <Message key={message.id} message={message} />)}
    </div>
    <form onSubmit={submit}>
      <label htmlFor="reader-question">{demo ? 'Ask the demo tutor' : 'Your question'}</label>
      <textarea id="reader-question" rows={3} maxLength={4000} placeholder={demo ? 'Ask about the idea or a worked example…' : 'Write a question about this concept…'}
        value={draft} readOnly={pending} onChange={event => setDraft(event.target.value)} aria-describedby="reader-question-detail" />
      <div className="reader-composer-footer">
        <p id="reader-question-detail" className="smallprint">{demo
          ? 'Practice with the offline sample tutor. This conversation stays on this device.'
          : 'Save a question on this device. A live tutor is not connected to this conversation.'}</p>
        <button type="submit" className="primary-btn" disabled={!draft.trim() || pending}>
          {pending ? 'Saving…' : demo ? 'Ask question' : 'Save question'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  </section>;
}
