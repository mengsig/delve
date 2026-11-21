import { useEffect, useRef, useState } from 'react';
import type { RepoPreview, RepoRequest } from '../../../shared/repository';
import { call, IpcCallError } from '../api';
import { errorMessage } from '../useRead';

export interface RepositoryFailure {
  code?: string;
  message: string;
  action: 'review' | 'provider' | 'retry';
}

export function repositoryFailure(cause: unknown): RepositoryFailure {
  const code = cause instanceof IpcCallError ? cause.code : undefined;
  const message = errorMessage(cause);
  if (code === 'PROVIDER_AUTH' || code === 'PROVIDER_NOT_FOUND') return { code, message, action: 'provider' };
  if (code?.startsWith('STALE_')) return { code, message, action: 'review' };
  return { code, message, action: 'retry' };
}

export function useRepositoryGeneration(start: (preview: RepoPreview) => boolean) {
  const active = useRef<RepoRequest | null>(null);
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<RepoPreview>();
  const [error, setError] = useState<RepositoryFailure>();

  useEffect(() => () => { active.current = null; }, []);

  async function inspect(request: RepoRequest) {
    if (active.current) return;
    active.current = request;
    setPending(true);
    setError(undefined);
    setPreview(undefined);
    try {
      const result = await call('repo:preview', request);
      if (!result.token) throw new Error('The preview is missing an approval token. Request a new preview.');
      if (active.current === request) setPreview(result);
    } catch (cause) {
      if (active.current === request) setError(repositoryFailure(cause));
    } finally {
      if (active.current === request) {
        active.current = null;
        setPending(false);
      }
    }
  }

  function approve() {
    if (!preview || active.current) return;
    try {
      if (!start(preview)) {
        setError({ message: 'This request is already in progress.', action: 'retry' });
        return;
      }
      setPreview(undefined);
      setError(undefined);
    } catch (cause) {
      setError(repositoryFailure(cause));
    }
  }

  function close() {
    setPreview(undefined);
    setError(undefined);
  }

  return { pending, preview, error, inspect, approve, close };
}
