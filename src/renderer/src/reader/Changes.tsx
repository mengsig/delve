import { useRef, useState } from 'react';
import type { ChangeRef } from '../../../shared/repository';
import { ReadingDepth } from '../explorer/ChangeExplanation';
import { ChangePage } from '../explorer/ChangePage';
import { Timeline } from '../explorer/Timeline';
import { Icon } from '../Icon';
import { changeJobKey, type ChangeJob } from '../repository/MapJobs';
import { DemoChanges } from './DemoChanges';
import type { ReaderProps } from './ReaderHeader';
import '../explorer/explorer.css';

interface Props extends ReaderProps {
  selected?: ChangeRef;
  openedJob?: ChangeJob;
  onSelect: (change: ChangeRef, title?: string) => void;
  onAtlas: (id: number) => void;
}

export function Changes(props: Props) {
  const [version, setVersion] = useState(0);
  const page = useRef<HTMLElement>(null);
  const { workspace, depth, selected, openedJob } = props;
  if (props.graph.demo || workspace.kind === 'topic') return <DemoChanges {...props} />;
  const key = selected && changeJobKey(workspace.id, selected, depth);
  function openPage() {
    requestAnimationFrame(() => page.current?.focus({ preventScroll: !window.matchMedia('(max-width: 800px)').matches }));
  }
  return <div className="explorer" onKeyDown={event => {
    if (event.key === 'Escape' && !event.defaultPrevented) document.getElementById('change-timeline')?.focus();
  }}>
    <header className="explorer-intro"><div><span className="eyebrow">Repository / {workspace.name}</span><h1>Changes<span className="atlas-period">.</span></h1></div>
      <ReadingDepth depth={depth} onDepth={props.onDepth} /></header>
    <div className="explorer-split">
      <Timeline workspaceId={workspace.id} selected={selected} onSelect={props.onSelect} onOpen={openPage} onRefresh={() => setVersion(value => value + 1)} />
      <section className="change-page" ref={page} tabIndex={-1} aria-label="Selected change">
        {selected ? <ChangePage key={key} historyVersion={version} {...props} change={selected} openedJob={openedJob?.key === key ? openedJob : undefined} />
          : <div className="change-placeholder"><Icon name="pr" /><h2>Choose a change</h2><p>Open a commit or pull request from the timeline.</p></div>}
      </section>
    </div>
  </div>;
}
