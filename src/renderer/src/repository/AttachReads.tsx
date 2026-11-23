import { useEffect, useMemo, useState } from 'react';
import type { Depth, ProviderId, ProviderStatus } from '../../../shared/domain';
import type { RepositoryInventory, RepoRequest } from '../../../shared/repository';
import { call, IpcCallError } from '../api';
import { errorMessage } from '../useRead';
import type { RepositoryInput } from '../workspaceSource';
import { defaultFiles, retainFiles } from './fileSelection';

type ReadResult<T> = { status: 'ready'; value: T } | { status: 'error'; cause: unknown };

function useAttachRead<T>(read: (() => Promise<T>) | undefined, enabled: boolean, delay: number) {
  const [version, setVersion] = useState(0);
  const [settled, setSettled] = useState<{ read: typeof read; version: number; result: ReadResult<T> }>();
  const result = settled?.read === read && settled?.version === version ? settled.result : undefined;

  useEffect(() => {
    if (!read || !enabled || result) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void read().then(
        value => { if (current) setSettled({ read, version, result: { status: 'ready', value } }); },
        cause => { if (current) setSettled({ read, version, result: { status: 'error', cause } }); },
      );
    }, delay);
    return () => { current = false; window.clearTimeout(timer); };
  }, [read, enabled, delay, version, result]);

  return { result, retry: () => setVersion(value => value + 1) };
}

export function useAttachInventory(source: RepositoryInput | undefined, cli: ProviderStatus | undefined) {
  const enabled = cli?.state === 'signed-in';
  const read = useMemo(() => source && (() => call('repo:stage', { source })), [source]);
  const { result, retry } = useAttachRead(read, enabled, 450);
  let error: { message: string; duplicate: boolean } | undefined;
  if (enabled && result?.status === 'error') {
    const { cause } = result;
    const duplicate = cause instanceof IpcCallError && cause.code === 'DUPLICATE_WORKSPACE';
    const message = errorMessage(cause);
    error = { message: duplicate ? message : 'Could not read repository files. ' + message, duplicate };
  }
  return {
    snapshot: result?.status === 'ready' ? result.value : undefined,
    error,
    pending: Boolean(source && enabled && !result),
    retry,
    canRetry: enabled,
  };
}

export function useAttachFiles(source: RepositoryInput | undefined, inventory: RepositoryInventory | undefined) {
  const [edited, setEdited] = useState<{ source: RepositoryInput; inventory: RepositoryInventory; paths: Set<string> }>();
  const selection = edited?.source === source ? edited : undefined;
  const selected = useMemo(() => {
    if (!inventory) return new Set<string>();
    if (!selection) return defaultFiles(inventory.files);
    return selection.inventory === inventory ? selection.paths : retainFiles(inventory.files, selection.paths);
  }, [inventory, selection]);
  return { selected, select: (paths: Set<string>) => { if (source && inventory) setEdited({ source, inventory, paths }); } };
}

export function useAttachPreview(
  workspaceId: string | undefined, commit: string | undefined, selected: Set<string>,
  depth: Depth, provider: ProviderId, signedIn: boolean,
) {
  const read = useMemo(() => {
    if (!workspaceId || !commit || !selected.size || !signedIn) return;
    const request: RepoRequest = {
      workspaceId, depth, provider, selection: { kind: 'baseline', commit, paths: Array.from(selected) },
    };
    return async () => {
      const preview = await call('repo:preview', request);
      if (!preview.token) throw new Error('The request is missing its approval token. Prepare it again.');
      if (preview.commit !== commit) throw new Error('The request used a different commit. Refresh the repository files.');
      const files = new Set(preview.files);
      if (files.size !== selected.size || Array.from(selected).some(path => !files.has(path))) {
        throw new Error('The request used a different file selection. Check the files and retry.');
      }
      return preview;
    };
  }, [workspaceId, commit, selected, depth, provider, signedIn]);
  const { result, retry } = useAttachRead(read, true, 250);
  return {
    preview: result?.status === 'ready' ? result.value : undefined,
    error: result?.status === 'error' ? errorMessage(result.cause) : undefined,
    pending: Boolean(read && !result),
    retry,
  };
}
