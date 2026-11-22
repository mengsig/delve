import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Depth } from '../../shared/domain';
import type { WorkspaceGraph } from '../../shared/graph';
import type { LessonAddress, ReaderLesson } from '../../shared/reader';
import { call } from './api';
import { buildLearningProgress, type CommittedCheckProgress, type StudyGraph } from './progress/model';
import { useBackgroundTutorCompletion } from './reader/TutorJobs';
import { useRepositoryCompletion } from './repository/MapJobs';
import { useRead } from './useRead';

export function useWorkspaceStudy(workspaceId: string | undefined, depth: Depth) {
  const readGraph = useCallback(() => workspaceId
    ? call('graph:read', { workspaceId, includeChangeLessons: true, depth })
    : Promise.resolve(undefined), [workspaceId, depth]);
  const readHead = useCallback(() => workspaceId
    ? call('workspaces:head', { workspaceId })
    : Promise.resolve(undefined), [workspaceId]);
  const { result, latestValue, refresh } = useRead(readGraph);
  const lastReady = latestValue?.workspaceId === workspaceId ? latestValue : undefined;
  const head = useRead(readHead);
  const [committed, setCommitted] = useState<{ graph: WorkspaceGraph; depth: Depth; checks: Map<number, CommittedCheckProgress> }>();
  const current = useRef({ lastReady, workspaceId, depth });
  useLayoutEffect(() => { current.current = { lastReady, workspaceId, depth }; }, [lastReady, workspaceId, depth]);
  useBackgroundTutorCompletion(workspaceId, depth, refresh);
  useRepositoryCompletion(workspaceId ?? '', refresh);
  useRepositoryCompletion(workspaceId ?? '', head.refresh);
  useEffect(() => {
    window.addEventListener('focus', head.refresh);
    return () => window.removeEventListener('focus', head.refresh);
  }, [head.refresh]);

  function commit(address: LessonAddress, lesson: ReaderLesson) {
    const scope = current.current;
    const graph = scope.lastReady;
    if (!graph || address.workspaceId !== scope.workspaceId || address.depth !== scope.depth) return;
    const { stage, attempts, correctAnswers } = lesson.mastery;
    setCommitted(previous => {
      const checks = new Map(previous?.graph === graph && previous.depth === address.depth ? previous.checks : undefined);
      checks.set(address.conceptId, { stage, attempts, correctAnswers });
      return { graph, depth: address.depth, checks };
    });
    refresh();
  }

  const graph = useMemo<StudyGraph | undefined>(() => {
    if (!lastReady) return undefined;
    const durable = result.status === 'error' ? { ...lastReady, progress: undefined } : lastReady;
    return committed?.graph === lastReady && committed.depth === depth
      ? { ...durable, committedChecks: committed.checks } : durable;
  }, [lastReady, committed, depth, result.status]);
  const progress = useMemo(() => graph && buildLearningProgress(graph, depth), [graph, depth]);
  return { graph, progress, commit, refresh, head: head.result.status === 'ready' ? head.result.value : head.result.status === 'error' ? { kind: 'unavailable' as const } : undefined,
    error: result.status === 'error' ? result.message : undefined };
}

export type WorkspaceStudy = ReturnType<typeof useWorkspaceStudy>;

export function atlasGraph(graph: StudyGraph): StudyGraph {
  if (!graph.atlasConceptIds) return graph;
  const ids = new Set(graph.atlasConceptIds);
  return {
    ...graph,
    concepts: graph.concepts.filter(concept => ids.has(concept.id)),
    edges: graph.edges.filter(edge => ids.has(edge.conceptId) && ids.has(edge.prerequisiteId)),
    evidence: graph.evidence.filter(evidence => ids.has(evidence.conceptId)),
  };
}
