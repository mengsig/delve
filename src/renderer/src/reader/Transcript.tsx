import { useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTutorJobs } from './TutorJobs';

interface Props {
  scope: string;
  lastMessage?: number;
  pendingTurn?: string;
  children: ReactNode;
}

function useTranscriptPosition({ scope, lastMessage, pendingTurn }: Omit<Props, 'children'>) {
  const { positions } = useTutorJobs();
  const [initial] = useState(() => positions.get(scope));
  const [reading, setReading] = useState<{ seen?: number } | null>(() => initial && !initial.following ? { seen: initial.seen } : null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(initial?.following ?? true);
  const restore = useRef(initial && !initial.following ? initial.top : undefined);

  const remember = useEffectEvent(() => {
    const node = scroller.current;
    if (!node || restore.current !== undefined) return;
    const bottom = node.scrollHeight - node.clientHeight - node.scrollTop < 48;
    const seen = bottom || following.current ? lastMessage : positions.get(scope)?.seen;
    following.current = bottom;
    positions.set(scope, { top: node.scrollTop, following: bottom, seen });
    setReading(prior => bottom ? null : prior ?? { seen });
  });
  const align = useEffectEvent(() => {
    const node = scroller.current;
    if (!node) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && node.contains(focused) && focused.closest('.lab-chapter')) {
      following.current = false;
      restore.current = undefined;
      return;
    }
    if (restore.current !== undefined) {
      node.scrollTop = restore.current;
      if (Math.abs(node.scrollTop - restore.current) < 1) restore.current = undefined;
    } else if (following.current && (lastMessage !== undefined || pendingTurn)) node.scrollTop = node.scrollHeight;
  });
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const stopRestoring = () => { restore.current = undefined; };
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    for (const event of events) node.addEventListener(event, stopRestoring, { passive: true });
    node.addEventListener('scroll', remember, { passive: true });
    const resize = new ResizeObserver(align);
    resize.observe(node);
    if (content.current) resize.observe(content.current);
    return () => {
      resize.disconnect();
      node.removeEventListener('scroll', remember);
      for (const event of events) node.removeEventListener(event, stopRestoring);
    };
  }, [scope]);
  useLayoutEffect(() => { align(); }, [lastMessage, pendingTurn]);
  function jump() {
    following.current = true;
    restore.current = undefined;
    const node = scroller.current;
    if (node) { node.scrollTop = node.scrollHeight; node.focus({ preventScroll: true }); }
    setReading(null);
  }
  return { scroller, content, jump, unread: reading !== null && reading.seen !== lastMessage };
}

export function Transcript({ children, ...props }: Props) {
  const { scroller, content, jump, unread } = useTranscriptPosition(props);
  return <div className="transcript-pane"><div ref={scroller} className="reader-scroll" tabIndex={0} aria-label="Lesson transcript">
    <div ref={content}>{children}</div>
  </div>{unread && <button className="new-reply" onClick={jump}>New reply ↓</button>}</div>;
}
