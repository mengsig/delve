import { afterEach, expect, it, vi } from 'vitest';
import { hasRepositoryApproval, setRepositoryApproval } from './repositoryApproval';

afterEach(() => vi.unstubAllGlobals());

it('keeps approval separate by workspace, provider and source category and can revoke it', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  setRepositoryApproval('repo-a', 'codex', 'change', true);
  expect(hasRepositoryApproval('repo-a', 'codex', 'change')).toBe(true);
  expect(hasRepositoryApproval('repo-b', 'codex', 'change')).toBe(false);
  expect(hasRepositoryApproval('repo-a', 'claude', 'change')).toBe(false);
  expect(hasRepositoryApproval('repo-a', 'codex', 'map')).toBe(false);
  setRepositoryApproval('repo-a', 'codex', 'map', true);
  setRepositoryApproval('repo-a', 'codex', 'change', false);
  expect(hasRepositoryApproval('repo-a', 'codex', 'change')).toBe(false);
  expect(hasRepositoryApproval('repo-a', 'codex', 'map')).toBe(true);
});
