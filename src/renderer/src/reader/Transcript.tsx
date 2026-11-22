import { useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTutorJobs } from './TutorJobs';

interface Props {
  scope: string;
  lastMessage?: number;
  pendingTurn?: string;
  children: ReactNode;
}

export function Transcript({ scope, lastMessage, pendingTurn, children }: Props) {
  const { positions } = useTutorJobs();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const last = useRef({ lastMessage, pendingTurn });
  const [reading, setReading] = useState<{ message?: number } | null>(null);
  const rememberReading = useEffectEvent((atBottom: boolean) => {
    setReading(prior => atBottom ? null : prior ?? { message: lastMessage });
  });
  const unread = reading !== null && reading.message !== lastMessage;
  const nearBottom = (node: HTMLElement) => node.scrollHeight - node.clientHeight - node.scrollTop < 48;

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const saved = positions.get(scope);
    if (saved !== undefined) {
      node.scrollTop = saved;
      follow.current = nearBottom(node);
      rememberReading(follow.current);
    } else if (last.current.lastMessage !== undefined) node.scrollTop = node.scrollHeight;
    function remember() {
      if (!node) return;
      positions.set(scope, node.scrollTop);
      follow.current = nearBottom(node);
      rememberReading(follow.current);
    }
    node.addEventListener('scroll', remember, { passive: true });
    const resize = new ResizeObserver(() => {
      if (follow.current && (last.current.lastMessage !== undefined || last.current.pendingTurn)) node.scrollTop = node.scrollHeight;
    });
    if (content.current) resize.observe(content.current);
    resize.observe(node);
    return () => { resize.disconnect(); node.removeEventListener('scroll', remember); };
  }, [positions, scope]);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || (last.current.lastMessage === lastMessage && last.current.pendingTurn === pendingTurn)) return;
    last.current = { lastMessage, pendingTurn };
    if (follow.current) node.scrollTop = node.scrollHeight;

  }, [lastMessage, pendingTurn]);

  return <div className="transcript-pane"><div ref={scroller} className="reader-scroll" tabIndex={0} aria-label="Lesson transcript">
    <div ref={content}>{children}</div>
  </div>{unread && <button className="new-reply" onClick={() => {
    const node = scroller.current;
    if (node) { node.scrollTop = node.scrollHeight; node.focus({ preventScroll: true }); }
    follow.current = true;
    setReading(null);
  }}>New reply ↓</button>}</div>;
}
