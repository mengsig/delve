import { useCallback, useState } from 'react';
import type { Depth, Workspace } from '../../../shared/domain';
import type { ChangeRef } from '../../../shared/repository';
import { call } from '../api';
import { preferredProvider } from '../preferences';
import { changeJobKey, jobInProgress, useMapJobs, useRepositoryCompletion, type ChangeJob } from '../repository/MapJobs';
import { useRepositoryGeneration } from '../repository/useRepositoryGeneration';
import { useRead } from '../useRead';

export function useChangeLesson(workspace: Workspace, change: ChangeRef, depth: Depth, openedJob?: ChangeJob) {
  const { kind, ref } = change;
  const [provider, chooseProvider] = useState(() => openedJob?.provider ?? preferredProvider());
  const query = useCallback(() => call('repo:saved', { workspaceId: workspace.id, kind, ref, depth, provider }),
    [workspace.id, kind, ref, depth, provider]);
  const saved = useRead(query);
  useRepositoryCompletion(workspace.id, saved.refresh);
  const queue = useMapJobs();
  const job = queue.jobs.get(changeJobKey(workspace.id, change, depth));
  const running = jobInProgress(job);
  const generation = useRepositoryGeneration(preview => queue.startChange({ workspace, depth, provider, change: { kind, ref }, preview }));
  const locked = running || Boolean(generation.pending || generation.preview);
  const inspect = () => generation.inspect({ workspaceId: workspace.id, depth, provider, selection: { kind, ref } });
  return { saved, provider, chooseProvider, generation, inspect, running, locked, job };
}

export type LessonState = ReturnType<typeof useChangeLesson>;
