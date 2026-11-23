import { useRef, useState } from 'react';
import type { Depth, ProviderId, Workspace, WorkspaceKind } from '../../shared/domain';
import type { RepoPreview } from '../../shared/repository';
import type { TopicPreview, TutorRequest } from '../../shared/reader';
import { call, IpcCallError } from './api';
import { setTutorApproval } from './reader/tutorApproval';
import { useTutorJobs } from './reader/TutorJobs';
import { useMapJobs } from './repository/MapJobs';
import { setRepositoryApproval } from './repository/repositoryApproval';
import { errorMessage } from './useRead';
import { SourceError, sourceInput, sourceRejection } from './sourceErrors';

export type WorkspaceAdded = (workspace: Workspace, depth: Depth, conceptId?: number, notice?: string) => void;

function addError(cause: unknown, action: string) {
  const message = errorMessage(cause);
  if (cause instanceof IpcCallError && cause.code === 'DUPLICATE_WORKSPACE') {
    return message + ' Open it from the workspace switcher.';
  }
  if (action === 'pick') return 'Could not choose a folder. ' + message;
  return (action === 'map' ? 'Could not attach the reviewed map request. ' : 'Could not add the workspace. ') + message;
}

interface ActionError { message: string; source: boolean }
const NO_ERROR: ActionError = { message: '', source: false };

function useWorkspaceActions() {
  const locked = useRef(false);
  const [pending, setPending] = useState<'pick' | 'add' | 'map' | null>(null);
  const [failure, setFailure] = useState<ActionError>(NO_ERROR);
  const [failedToken, setFailedToken] = useState<string>();

  async function run(action: NonNullable<typeof pending>, apply: () => Promise<void>, preview?: RepoPreview) {
    if (locked.current) return;
    locked.current = true;
    setPending(action);
    setFailure(NO_ERROR);
    try {
      await apply();
    } catch (cause) {
      setFailure({ message: addError(cause, action), source: cause instanceof SourceError });
      if (preview) setFailedToken(preview.token);
    } finally {
      setPending(null);
      locked.current = false;
    }
  }

  return {
    pending, error: failure.message, sourceError: failure.source, failedToken, run,
    setError: (message: string) => setFailure({ message, source: false }),
    clearError: () => setFailure(NO_ERROR),
  };
}

function sameRequest(reviewed: TopicPreview, current: TopicPreview) {
  return reviewed.prompt === current.prompt && reviewed.bytes === current.bytes && reviewed.model === current.model
    && reviewed.modelSource === current.modelSource && reviewed.files.length === current.files.length
    && reviewed.files.every((file, index) => file === current.files[index]);
}

export function useStartWorkspace(onAdded: WorkspaceAdded, depth: Depth, provider: ProviderId) {
  const actions = useWorkspaceActions();
  const incompleteTopic = useRef<Workspace | null>(null);
  const { start: map } = useMapJobs();
  const { start: teach, reportFailure } = useTutorJobs();

  function addOnly(kind: WorkspaceKind, value: string, reviewed?: TopicPreview, rememberTutor = false) {
    void actions.run('add', async () => {
      const input = sourceInput(kind, value);
      const add = () => call('workspaces:add', input).catch(cause => { throw sourceRejection(cause); });
      if (input.kind !== 'topic') return onAdded(await add(), depth);
      const saved = incompleteTopic.current;
      const workspace = saved?.name === input.title ? saved : await add();
      incompleteTopic.current = workspace;
      const conceptId = await call('reader:start-topic', { workspaceId: workspace.id });
      incompleteTopic.current = null;
      if (reviewed) {
        const request: TutorRequest = { workspaceId: workspace.id, conceptId, depth, provider, intent: { kind: 'teach' } };
        try {
          const current = await call('tutor:preview', request);
          if (!sameRequest(reviewed, current)) throw new IpcCallError('STALE_PREVIEW', 'The tutor request changed. Review the current request and retry.');
          if (rememberTutor) setTutorApproval(workspace.id, provider, true);
          if (!teach({ request, token: current.token, title: workspace.name })) throw new Error('This lesson is already being prepared.');
        } catch (cause) {
          reportFailure(request, workspace.name, cause);
        }
      }
      onAdded(workspace, depth, conceptId);
    });
  }

  function buildMap(preview: RepoPreview, allowed: boolean) {
    void actions.run('map', async () => {
      const workspace = await call('repo:attach', { token: preview.token });
      const started = map({ workspace, depth, provider, preview });
      let notice = started ? undefined : 'This repository already has a map in progress.';
      if (allowed) {
        try { setRepositoryApproval(workspace.id, provider, 'map', true); }
        catch (cause) { notice = 'The map is building, but Delve could not save your approval. ' + errorMessage(cause); }
      }
      onAdded(workspace, depth, undefined, notice);
    }, preview);
  }
  return { ...actions, addOnly, buildMap };
}
