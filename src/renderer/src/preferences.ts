import { DEFAULT_DEPTH, DEPTHS, type Depth, type ProviderId } from '../../shared/domain';

const depthKey = (workspaceId: string) => `delve.depth.${workspaceId}`;

export function workspaceDepth(workspaceId: string): Depth {
  const stored = localStorage.getItem(depthKey(workspaceId));
  return DEPTHS.find(depth => depth === stored) ?? DEFAULT_DEPTH;
}

export function storeDepth(workspaceId: string, depth: Depth) {
  localStorage.setItem(depthKey(workspaceId), depth);
}

export type AtlasView = 'contour' | 'folio';

export function atlasView(): AtlasView {
  return localStorage.getItem('delve.view') === 'folio' ? 'folio' : 'contour';
}

export const PROVIDER_LABELS: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude Code' };
const providerKey = 'delve.provider';

export function preferredProvider(): ProviderId {
  return localStorage.getItem(providerKey) === 'claude' ? 'claude' : 'codex';
}

export function storeProvider(provider: ProviderId) {
  localStorage.setItem(providerKey, provider);
}

const onboardingKey = 'delve.onboarding-dismissed';

export function onboardingDismissed() {
  return localStorage.getItem(onboardingKey) === '1';
}

export function dismissOnboarding() {
  localStorage.setItem(onboardingKey, '1');
}
