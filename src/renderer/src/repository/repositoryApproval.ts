import { useState } from 'react';
import type { ProviderId } from '../../../shared/domain';

export type RepositoryCategory = 'map' | 'change';

function approvalKey(workspaceId: string, provider: ProviderId, category: RepositoryCategory) {
  if (!workspaceId) throw new Error('Source approval needs a workspace.');
  if (category !== 'map' && category !== 'change') throw new Error('Unknown source approval category.');
  return 'delve.repository-approval.' + JSON.stringify([workspaceId, provider, category]);
}

export function hasRepositoryApproval(workspaceId: string, provider: ProviderId, category: RepositoryCategory) {
  return localStorage.getItem(approvalKey(workspaceId, provider, category)) === '1';
}

export function setRepositoryApproval(workspaceId: string, provider: ProviderId, category: RepositoryCategory, allowed: boolean) {
  const key = approvalKey(workspaceId, provider, category);
  if (allowed) localStorage.setItem(key, '1');
  else localStorage.removeItem(key);
}

export function useRepositoryApproval(workspaceId: string, provider: ProviderId, category: RepositoryCategory) {
  const [, refresh] = useState(0);
  const allowed = hasRepositoryApproval(workspaceId, provider, category);

  function setAllowed(next: boolean) {
    setRepositoryApproval(workspaceId, provider, category, next);
    refresh(version => version + 1);
  }

  return { allowed, setAllowed };
}
