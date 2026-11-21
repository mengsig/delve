import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeRef } from '../../../shared/repository';
import { call } from '../api';
import type { ReaderProps } from '../reader/ReaderHeader';
import { useRepositoryCompletion, type ChangeJob } from '../repository/MapJobs';
import { CopyGitHubLogin } from '../repository/ProviderReview';
import { useRead } from '../useRead';
import { ChangeConcepts, ChangeExplanation } from './ChangeExplanation';
import { ChangeFiles } from './ChangeFiles';
import { ChangeHeading } from './ChangeHeading';
import { ChangeTabs, tabId, type ChangeTab } from './ChangeTabs';
import { useChangeLesson } from './useChangeLesson';

interface Props extends Pick<ReaderProps, 'workspace' | 'depth' | 'graph' | 'onLesson'> {
  change: ChangeRef;
  version: number;
  onAtlas: (id: number) => void;
  openedJob?: ChangeJob;
}

function useChangePage({ workspace, depth, change, openedJob, onLesson, version }: Props) {
  const { kind, ref } = change;
  const query = useCallback(() => call('repo:detail', { workspaceId: workspace.id, kind, ref }), [workspace.id, kind, ref]);
  const read = useRead(query, version);
  useRepositoryCompletion(workspace.id, read.refresh);
  const detail = read.result.status === 'ready' ? read.result.value : undefined;
  const lesson = useChangeLesson(workspace, change, depth, openedJob);
  const saved = lesson.saved.result.status === 'ready' ? lesson.saved.result.value : null;
  const stale = Boolean(detail && !detail.savedOnly && saved && (saved.commit !== detail.node.head || saved.base !== detail.base));
  const brief = stale ? undefined : saved ?? undefined;
  const [teaching, setTeaching] = useState(false);
  const [tab, selectTab] = useState<ChangeTab>('Explanation');
  const pendingLesson = useRef(false);
  function startLesson() {
    if (brief) return onLesson(brief.conceptId);
    selectTab('Explanation');
    setTeaching(true);
    pendingLesson.current = true;
    if (!lesson.locked) void lesson.inspect();
  }
  function changeTab(next: ChangeTab) {
    pendingLesson.current = false;
    setTeaching(false);
    selectTab(next);
  }
  useEffect(() => {
    if (pendingLesson.current && brief && !lesson.running) {
      pendingLesson.current = false;
      onLesson(brief.conceptId);
    }
  }, [brief, lesson.running, onLesson]);
  return { read, detail, lesson, stale, brief, teaching, tab, changeTab, startLesson };
}

export function ChangePage(props: Props) {
  const { change, depth, graph, onLesson, onAtlas } = props;
  const { read, detail, lesson, stale, brief, teaching, tab, changeTab, startLesson } = useChangePage(props);
  const atlasIds = useMemo(() => new Set(graph.concepts.map(concept => concept.id)), [graph.concepts]);
  function explain() {
    changeTab('Explanation');
    if (!lesson.locked) void lesson.inspect();
  }
  return <>
    <ChangeHeading change={change} detail={detail} savedTitle={brief?.title} onTeach={startLesson}
      disabled={teaching || read.result.status === 'loading' || lesson.saved.result.status === 'loading'} />
    {read.result.status === 'loading' && <p role="status" className="panel-message">Reading change details…</p>}
    {read.result.status === 'error' && <div className="repository-notice"><p role="alert">{read.result.message}</p>
      <CopyGitHubLogin message={read.result.message} /><button onClick={read.refresh}>Retry change details</button></div>}
    {detail?.savedOnly && <div className="repository-notice" role="status">
      <p>{detail.coverageNote ?? 'Source unavailable. Showing saved change information.'}</p>
      <CopyGitHubLogin message={detail.coverageNote ?? ''} /><button onClick={read.refresh}>Retry change details</button>
    </div>}
    <ChangeTabs selected={tab} onSelect={changeTab} />
    <section className="change-panel" id="change-panel" role="tabpanel" aria-labelledby={tabId(tab)} tabIndex={0}>
      {tab === 'Explanation' && <ChangeExplanation brief={brief} stale={stale} description={detail?.description} lesson={lesson}
        depth={depth} onLesson={onLesson} teaching={teaching} onBack={() => changeTab('Explanation')} />}
      {tab === 'Files changed' && (detail ? <ChangeFiles detail={detail} brief={brief}
        onConcept={onAtlas} />
        : <p className="panel-message">{read.result.status === 'loading' ? 'Loading file patches…' : 'The source diff is unavailable.'}</p>)}
      {tab === 'Concepts' && <ChangeConcepts brief={brief} atlasIds={atlasIds} onAtlas={onAtlas} onExplain={explain} />}
    </section>
  </>;
}
