import { useEffect, useRef, useState } from 'react';
import type { GenerationResult, RepoPreview, RepoRequest } from '../../../shared/repository';
import { call } from '../api';
import { errorMessage } from '../useRead';

type Attempt = { id: string; phase: 'preview' | 'generate' };

export function useRepositoryGeneration(onGenerated: (result: GenerationResult) => void) {
  const active = useRef<Attempt | null>(null);
  const [pending, setPending] = useState<Attempt['phase']>();
  const [preview, setPreview] = useState<RepoPreview>();
  const [error, setError] = useState('');

  useEffect(() => () => {
    const attempt = active.current;
    active.current = null;
    if (attempt?.phase === 'generate') {
      void call('repo:cancel', { requestId: attempt.id }).catch(error => console.error('Repository cancellation failed', error));
    }
  }, []);

  async function run(phase: Attempt['phase'], execute: (attempt: Attempt) => Promise<void>) {
    if (active.current) return;
    const attempt: Attempt = { id: crypto.randomUUID(), phase };
    active.current = attempt;
    setPending(phase);
    setError('');
    try {
      await execute(attempt);
    } catch (cause) {
      if (active.current === attempt) setError(errorMessage(cause));
    } finally {
      if (active.current === attempt) {
        active.current = null;
        setPending(undefined);
      }
    }
  }
  function inspect(request: RepoRequest) {
    setPreview(undefined);
    return run('preview', async attempt => {
      const result = await call('repo:preview', request);
      if (active.current === attempt) setPreview(result);
    });
  }
  function approve() {
    if (!preview) return;
    setPreview(undefined);
    return run('generate', async attempt => {
      const result = await call('repo:generate', { token: preview.token, requestId: attempt.id });
      if (active.current === attempt) onGenerated(result);
    });
  }
  async function cancel() {
    const attempt = active.current;
    if (attempt?.phase !== 'generate') return;
    try {
      const cancelled = await call('repo:cancel', { requestId: attempt.id });
      if (!cancelled && active.current === attempt) setError('The request could not be cancelled yet.');
    } catch (cause) {
      if (active.current === attempt) setError(errorMessage(cause));
    }
  }
  return { pending, preview, error, inspect, approve, cancel, close: () => setPreview(undefined) };
}
