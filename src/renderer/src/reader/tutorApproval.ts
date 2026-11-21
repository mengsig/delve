import type { ProviderId } from '../../../shared/domain';

const approvalKey = (workspaceId: string, provider: ProviderId) => `delve.approval.tutor.${workspaceId}.${provider}`;

export function hasTutorApproval(workspaceId: string, provider: ProviderId) {
  return localStorage.getItem(approvalKey(workspaceId, provider)) === 'always';
}

export function setTutorApproval(workspaceId: string, provider: ProviderId, allowed: boolean) {
  const key = approvalKey(workspaceId, provider);
  if (allowed) localStorage.setItem(key, 'always');
  else localStorage.removeItem(key);
}
