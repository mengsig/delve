import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from 'react';
import type { HistoryNode, HistoryPage } from '../../../shared/explorer';
import type { ChangeRef } from '../../../shared/repository';
import { changeKey, type LaneRow } from './lanes';
import { CopyGitHubLogin } from '../repository/ProviderReview';
import { graphWidth, ROW_HEIGHT, TimelineRow } from './TimelineRow';

const overscan = 5;

function visibleRows(top: number, height: number, count: number, active: number) {
  if (top < 0 || height < 0) throw new Error('History viewport has invalid dimensions.');
  if (active < -1 || active >= count) throw new Error('History focus is outside the loaded changes.');
  const first = Math.min(count, Math.max(0, Math.floor(top / ROW_HEIGHT) - overscan));
  const last = Math.min(count, Math.ceil((top + height) / ROW_HEIGHT) + overscan);
  const indices = Array.from({ length: last - first }, (_, offset) => first + offset);
  if (active >= 0 && active < first) indices.unshift(active);
  if (active >= last) indices.push(active);
  return indices;
}

function reveal(viewport: HTMLDivElement, index: number) {
  const top = index * ROW_HEIGHT;
  if (top < viewport.scrollTop) viewport.scrollTop = top;
  else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) {
    viewport.scrollTop = top + ROW_HEIGHT - viewport.clientHeight;
  }
}

function nextFocus(key: string, active: number, pageLength: number, count: number) {
  switch (key) {
    case 'ArrowDown': return Math.min(count - 1, active + 1);
    case 'ArrowUp': return Math.max(0, active - 1);
    case 'PageDown': return Math.min(count - 1, active + pageLength);
    case 'PageUp': return Math.max(0, active - pageLength);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return undefined;
  }
}

function useViewport(count: number, loadMore: () => void) {
  const viewport = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ top: 0, height: 336 });
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const read = () => setBounds({ top: Math.max(0, element.scrollTop), height: element.clientHeight });
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  function scroll({ currentTarget }: UIEvent<HTMLDivElement>) {
    const top = Math.max(0, currentTarget.scrollTop);
    const height = currentTarget.clientHeight;
    setBounds({ top, height });
    if (top + height >= count * ROW_HEIGHT - (overscan * ROW_HEIGHT)) loadMore();
  }
  return { viewport, bounds, scroll };
}

interface ViewportProps {
  query: string;
  nodes: HistoryNode[];
  layout?: LaneRow[];
  selected?: ChangeRef;
  more: boolean;
  loadMore: () => void;
  onSelect: (node: ChangeRef, title?: string) => void;
  onOpen?: () => void;
}

export function HistoryViewport({ query, nodes, layout, selected, more, loadMore, onSelect, onOpen }: ViewportProps) {
  const width = useMemo(() => graphWidth(layout), [layout]);
  const { viewport, bounds, scroll } = useViewport(nodes.length, loadMore);
  const [focus, setFocus] = useState<{ query: string; index?: number }>({ query });
  if (focus.query !== query) setFocus({ query });
  const selectedKey = selected && changeKey(selected);
  const selectedIndex = useMemo(() => {
    if (!selectedKey) return -1;
    const exact = nodes.findIndex(node => changeKey(node) === selectedKey);
    if (exact >= 0 || !selectedKey.startsWith('commit/')) return exact;
    const matches = nodes.filter(node => changeKey(node).startsWith(selectedKey.toLowerCase()));
    return matches.length === 1 ? nodes.indexOf(matches[0]!) : -1;
  }, [nodes, selectedKey]);
  const fallback = selectedIndex >= 0 ? selectedIndex : Math.min(0, nodes.length - 1);
  const active = focus.query === query && focus.index !== undefined && focus.index < nodes.length ? focus.index : fallback;
  const indices = visibleRows(bounds.top, bounds.height, nodes.length, active);

  function choose({ kind, ref, title }: HistoryNode) {
    onSelect({ kind, ref }, title);
    onOpen?.();
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (active < 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const node = nodes[active];
      if (!node) throw new Error('History focus has no corresponding change.');
      if (!event.repeat) choose(node);
      return;
    }
    const pageLength = Math.max(1, Math.floor(event.currentTarget.clientHeight / ROW_HEIGHT));
    const index = nextFocus(event.key, active, pageLength, nodes.length);
    if (index === undefined) return;
    event.preventDefault();
    setFocus({ query, index });
    reveal(event.currentTarget, index);
    if (index >= nodes.length - overscan && ['ArrowDown', 'PageDown', 'End'].includes(event.key)) loadMore();
  }

  return <div id="change-timeline" ref={viewport} className="timeline-viewport"
    tabIndex={active < 0 ? -1 : 0} role={active < 0 ? 'region' : 'listbox'}
    aria-labelledby="change-timeline-label" aria-activedescendant={active < 0 ? undefined : `change-timeline-row-${active}`}
    onFocus={event => { if (active >= 0 && event.target === event.currentTarget) reveal(event.currentTarget, active); }}
    onScroll={scroll} onKeyDown={handleKey}>
    <div role="presentation" className="timeline-list" style={{ height: nodes.length * ROW_HEIGHT }}>
      {indices.map(index => {
        const node = nodes[index];
        if (!node) throw new Error('History viewport tried to render an unloaded change.');
        return <TimelineRow key={changeKey(node)} node={node} layout={layout?.[index]} width={width} index={index}
          size={more ? -1 : nodes.length} selected={selectedIndex === index} active={active === index}
          onSelect={() => {
            viewport.current?.focus({ preventScroll: true });
            if (viewport.current) reveal(viewport.current, index);
            setFocus({ query, index });
            choose(node);
          }} />;
      })}
    </div>
  </div>;
}

export function HistoryNotice({ page }: { page: HistoryPage }) {
  const empty = page.pullStatus === 'empty' && 'No pull requests in this repository.';
  const local = page.pullStatus === 'local' && 'No pull requests available for this local repository.';
  const unavailable = page.pullStatus === 'unavailable' && 'GitHub pull requests are unavailable.';
  const text = empty || local || unavailable;
  if (!text && !page.warning) return null;
  return <div className="timeline-notice" role="status">
    {text && <p>{text}</p>}
    {page.warning && <><p>{page.warning}</p><CopyGitHubLogin message={page.warning} /></>}
  </div>;
}
