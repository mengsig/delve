import { createContext, useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import type { LessonAddress, LessonBlock, ReaderLesson } from '../../../shared/reader';
import { call } from '../api';
import { errorMessage } from '../useRead';
import { closeLab, InstrumentHost } from './host';

type Block = Extract<LessonBlock, { type: 'environment' }>;
interface Scope {
  address: LessonAddress;
  revision: string | null;
  active: string | null;
  select: (id: string) => void;
  onLesson: (lesson: ReaderLesson) => void;
}
const LabContext = createContext<Scope | null>(null);
const blockKey = (messageId: number | null, index: number) => (messageId ?? 'opening') + '/' + index;
const runnable = (block: LessonBlock) => block.type === 'environment' && Boolean(block.pack || block.config);

function latestInstrument(body: ReaderLesson): string | null {
  const message = body.messages.findLast(entry => entry.blocks?.some(runnable));
  if (message?.blocks) return blockKey(message.id, message.blocks.findIndex(runnable));
  const index = body.blocks.findIndex(runnable);
  return index >= 0 ? blockKey(null, index) : null;
}

export function LessonInstruments({ address, body, onLesson, children }: {
  address: LessonAddress; body: ReaderLesson; onLesson: Scope['onLesson']; children: ReactNode;
}) {
  const latest = latestInstrument(body);
  const [choice, setChoice] = useState<{ latest: string | null; active: string }>();
  const active = choice?.latest === latest ? choice.active : latest;
  return <LabContext.Provider value={{ address, revision: body.revision, active,
    select: id => setChoice({ latest, active: id }), onLesson }}>{children}</LabContext.Provider>;
}

function TextAlternative({ text, expanded = false }: { text?: string; expanded?: boolean }) {
  if (!text) return null;
  return <details open={expanded}><summary>Text alternative</summary><p>{text}</p></details>;
}

function LiveStage({ title, scope, messageId, blockIndex, fallback }: {
  title: string; scope: Scope; messageId: number | null; blockIndex: number; fallback?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [observation, setObservation] = useState('');
  const { workspaceId, conceptId, depth } = scope.address;
  const { revision } = scope;
  const observed = useEffectEvent((lesson: ReaderLesson) => {
    const entry = lesson.messages.at(-1);
    setObservation([entry?.observation, entry?.recommendation?.reason].filter(Boolean).join(' '));
    scope.onLesson(lesson);
  });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let active = true;
    let host: InstrumentHost | undefined;
    const request = { workspaceId, conceptId, depth, revision, messageId, blockIndex };
    void call('lab:open', request).then(opened => {
      if (!active) { void closeLab(opened.session); return; }
      host = new InstrumentHost(element, title, opened, { onLesson: observed, onFailure: setFailure });
    }).catch(error => { if (active) setFailure(errorMessage(error)); });
    return () => { active = false; host?.close(); };
  }, [workspaceId, conceptId, depth, revision, messageId, blockIndex, title, attempt]);
  return <>
    <div ref={container} />
    {failure && <div className="reader-notice" role="status"><p>Instrument unavailable. {failure}</p>
      <button onClick={() => { setFailure(''); setObservation(''); setAttempt(value => value + 1); }}>Restart instrument</button></div>}
    {observation && <p className="lab-update" role="status">{observation}</p>}
    <TextAlternative text={fallback} expanded={Boolean(failure)} />
  </>;
}

export function Environment({ block, messageId, blockIndex }: { block: Block; messageId: number | null; blockIndex: number }) {
  const scope = useContext(LabContext);
  const key = blockKey(messageId, blockIndex);
  const active = scope?.active === key;
  const pack = block.config?.pack ?? block.pack;
  const heading = pack === 'lease-handoff@1' ? 'The handoff bench' : pack === 'camera-exposure@1' ? 'The exposure bench'
    : pack === 'network-builder@1' ? 'The network bench' : block.title ?? 'Instrument';
  return <section className="chapter lab-chapter" id={active ? 'instrument' : undefined}>
    <span className="eyebrow">{pack === 'bundle@1' ? 'Custom instrument / practice only' : 'Interactive environment / delve.env/1'}</span><h3>{heading}</h3>
    {pack && scope ? active
      ? <LiveStage title={heading} scope={scope} messageId={messageId} blockIndex={blockIndex} fallback={block.fallback} />
      : <button onClick={() => scope.select(key)}>Open instrument</button>
      : <p>Instrument unavailable for this lesson.</p>}
    {(!active || !pack) && <TextAlternative text={block.fallback} expanded={!pack} />}
  </section>;
}
