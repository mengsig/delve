import { useCallback, useMemo, useState } from 'react';
import type { ChangeRef } from '../../../shared/repository';
import { call } from '../api';
import type { ReaderProps } from '../reader/ReaderHeader';
import type { ChangeJob } from '../repository/MapJobs';
import { CopyGitHubLogin } from '../repository/ProviderReview';
import { useRead } from '../useRead';
import { ChangeConcepts, ChangeExplanation } from './ChangeExplanation';
import { ChangeFiles } from './ChangeFiles';
import { ChangeHeading } from './ChangeHeading';
import { ChangeLessonAction } from './ChangeLessonAction';
import { ChangeTabs, tabId, type ChangeTab } from './ChangeTabs';
import { useChangeLesson } from './useChangeLesson';

interface Props extends Pick<ReaderProps, 'workspace' | 'depth' | 'graph' | 'onLesson'> {
  change: ChangeRef;
  historyVersion: number;
  onAtlas: (id: number) => void;
  onEvidence: () => void;
  openedJob?: ChangeJob;
}

type DetailRead = ReturnType<typeof useChangeDetail>;

function useChangeDetail(workspaceId: string, { kind, ref }: ChangeRef, historyVersion: number) {
  const [version, setVersion] = useState(0);
  // Refresh invalidates the old detail and its approval preview before the new read starts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const query = useCallback(() => call('repo:detail', { workspaceId, kind, ref }), [workspaceId, kind, ref, version, historyVersion]);
  return { result: useRead(query).result, refresh: () => setVersion(value => value + 1) };
}

function ChangeDetailStatus({ read }: { read: DetailRead }) {
  const { result, refresh } = read;
  if (result.status === 'loading') return <p role="status" className="panel-message">Reading change details…</p>;
  const savedOnly = result.status === 'ready' && result.value.savedOnly;
  if (result.status === 'ready' && !savedOnly) return null;
  const message = result.status === 'error' ? result.message
    : result.value.coverageNote ?? 'Source unavailable. Showing saved change information.';
  return <div className="repository-notice">
    <p role={savedOnly ? 'status' : 'alert'}>{message}</p>
    <CopyGitHubLogin message={message} />
    <button onClick={refresh}>Retry change details</button>
  </div>;
}

export function ChangePage({ workspace, change, depth, graph, onLesson, onAtlas, onEvidence, historyVersion, openedJob }: Props) {
  const [tab, setTab] = useState<ChangeTab>('Explanation');
  const read = useChangeDetail(workspace.id, change, historyVersion);
  const detail = read.result.status === 'ready' ? read.result.value : undefined;
  const lesson = useChangeLesson({ workspace, change, depth, openedJob, detail, onLesson });
  const { brief } = lesson;
  const atlasIds = useMemo(() => new Set(graph.concepts.map(concept => concept.id)), [graph.concepts]);
  function selectTab(next: ChangeTab) {
    lesson.stayOnPage();
    setTab(next);
  }

  return <>
    <ChangeHeading change={change} detail={detail} savedTitle={brief?.title} />
    <ChangeLessonAction lesson={lesson} depth={depth} onLesson={onLesson} onRefreshDetails={read.refresh}
      checkingDetails={read.result.status === 'loading'} />
    <ChangeDetailStatus read={read} />
    <ChangeTabs selected={tab} onSelect={selectTab} />
    <section className="change-panel" id="change-panel" role="tabpanel" aria-labelledby={tabId(tab)} tabIndex={0}>
      {tab === 'Explanation' && <ChangeExplanation description={detail?.description} lesson={lesson}
        workspaceId={workspace.id} depth={depth} onLesson={onLesson} onEvidence={onEvidence} />}
      {tab === 'Files changed' && (detail ? <ChangeFiles detail={detail} brief={brief} onConcept={onAtlas} />
        : <p className="panel-message">{read.result.status === 'loading' ? 'Loading file patches…' : 'The source diff is unavailable.'}</p>)}
      {tab === 'Concepts' && <ChangeConcepts brief={brief} atlasIds={atlasIds} depth={depth} onAtlas={onAtlas} />}
    </section>
  </>;
}
