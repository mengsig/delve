import { useCallback, useEffect, useRef, useState } from 'react';
import type { Depth, Workspace } from '../../../shared/domain';
import type { ChangeDetail } from '../../../shared/explorer';
import type { ChangeRef, RepoPreview } from '../../../shared/repository';
import { call } from '../api';
import { preferredProvider } from '../preferences';
import { changeJobKey, jobInProgress, useMapJobs, useRepositoryCompletion, type ChangeJob } from '../repository/MapJobs';
import { useRepositoryApproval } from '../repository/repositoryApproval';
import { errorMessage, useRead } from '../useRead';

function useChangePreview(workspace: Workspace, change: ChangeRef, depth: Depth, provider: ChangeJob['provider'], detail?: ChangeDetail) {
  const { kind, ref } = change;
  const [version, setVersion] = useState(0);
  // Retry hides the previous token while a fresh preview is being prepared.
  const query = useCallback(async () => {
    if (!detail) return;
    const preview = await call('repo:preview', { workspaceId: workspace.id, depth, provider, selection: { kind, ref } });
    if (!preview.token) throw new Error('The reviewed diff is missing its approval token. Prepare it again.');
    if (preview.commit !== detail.node.head || preview.base !== detail.base) {
      throw new Error('The change moved while preparing its diff. Refresh the change details before sending.');
    }
    return preview;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, kind, ref, depth, provider, detail, version]);
  return { result: useRead(query).result, retry: () => setVersion(value => value + 1) };
}

interface LessonOptions {
  workspace: Workspace;
  change: ChangeRef;
  depth: Depth;
  detail?: ChangeDetail;
  openedJob?: ChangeJob;
  onLesson: (id: number) => void;
}

function useTeachChange({ workspace, change, depth, onLesson }: LessonOptions, provider: ChangeJob['provider']) {
  const queue = useMapJobs();
  const job = queue.jobs.get(changeJobKey(workspace.id, change, depth));
  const approval = useRepositoryApproval(workspace.id, provider, 'change');
  const [draftToken, setDraftToken] = useState<string>();
  const teachingToken = useRef<string | undefined>(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    if (teachingToken.current && job?.token === teachingToken.current && job.phase === 'ready' && job.conceptId !== undefined) {
      teachingToken.current = undefined;
      onLesson(job.conceptId);
    }
  }, [job, onLesson]);

  function start(preview: RepoPreview, teach: boolean) {
    setError('');
    try {
      if (draftToken === preview.token) approval.setAllowed(true);
      if (!queue.startChange({ workspace, depth, provider, change, preview })) {
        setError('This change is already being taught. Wait for it to finish or cancel it.');
        return false;
      }
      teachingToken.current = teach ? preview.token : undefined;
      setDraftToken(undefined);
      return true;
    } catch (cause) {
      setError('Could not start the change lesson. ' + errorMessage(cause));
      return false;
    }
  }

  return { job, running: jobInProgress(job), approval, draftToken, setDraftToken, error, start,
    stayOnPage: () => { teachingToken.current = undefined; } };
}

export function useChangeLesson(options: LessonOptions) {
  const { workspace, change, depth, openedJob, detail } = options;
  const { kind, ref } = change;
  const [provider, chooseProvider] = useState(() => openedJob?.provider ?? preferredProvider());
  const [reviewRefresh, setReviewRefresh] = useState(false);
  const query = useCallback(() => call('repo:saved', { workspaceId: workspace.id, kind, ref, depth, provider }),
    [workspace.id, kind, ref, depth, provider]);
  const saved = useRead(query);
  useRepositoryCompletion(workspace.id, saved.refresh);
  const latest = saved.result.status === 'ready' ? saved.result.value : null;
  const stale = Boolean(detail && !detail.savedOnly && latest && (latest.commit !== detail.node.head || latest.base !== detail.base));
  const brief = stale ? undefined : latest ?? undefined;
  const sourceAvailable = Boolean(detail && !detail.savedOnly);
  const canPrepare = sourceAvailable && saved.result.status === 'ready' && (!brief || reviewRefresh);
  const review = useChangePreview(workspace, change, depth, provider, canPrepare ? detail : undefined);
  const generation = useTeachChange(options, provider);
  return { saved, brief, stale, provider, chooseProvider, review, reviewRefresh, setReviewRefresh, canPrepare, sourceAvailable, ...generation };
}

export type LessonState = ReturnType<typeof useChangeLesson>;
