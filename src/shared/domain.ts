export const WORKSPACE_KINDS = ['git', 'github', 'topic'] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export interface Workspace {
  id: string;
  kind: WorkspaceKind;
  name: string;
  /** Absolute path for `git`, `owner/name` for `github`, the title for `topic`. */
  source: string;
  createdAt: string;
  lastOpenedAt: string | null;
}

export type AddWorkspaceInput =
  | { kind: 'git'; path: string }
  | { kind: 'github'; owner: string; repo: string }
  | { kind: 'topic'; title: string };

export interface WorkspaceList {
  workspaces: Workspace[];
  activeId: string | null;
}

/** Shallow to deep: each depth adds detail to the one before it. */
export const DEPTHS = ['high', 'medium', 'low'] as const;
export type Depth = (typeof DEPTHS)[number];
export const DEFAULT_DEPTH: Depth = 'medium';

export const PROVIDER_IDS = ['claude', 'codex'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderState = 'not-found' | 'signed-out' | 'signed-in' | 'unknown';

export interface ProviderStatus {
  id: ProviderId;
  state: ProviderState;
  /** Resolved executable path when found. */
  path: string | null;
  version: string | null;
  /** Human-readable explanation, e.g. why sign-in state is unknown. */
  detail: string;
}
