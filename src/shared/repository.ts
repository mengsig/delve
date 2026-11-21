import type { ConceptSpan } from './change-diff';
import type { AddWorkspaceInput, Depth, ProviderId, Workspace } from './domain';

import type { ChangeDetail, DetailRequest, HistoryPage, HistoryRequest } from './explorer';

export interface ChangeRef {
  kind: 'commit' | 'pr';
  ref: string;
}

export interface RepositoryFile {
  path: string;
  bytes: number;
}

export interface RepositoryInventory {
  commit: string;
  files: RepositoryFile[];
  partial: boolean;
}

export type RepoSelection = ChangeRef | { kind: 'baseline'; commit: string; paths: string[] };

export interface RepoRequest {
  workspaceId: string;
  depth: Depth;
  provider: ProviderId;
  selection: RepoSelection;
}

export interface RepoPreview {
  token: string;
  model: string;
  prompt: string;
  bytes: number;
  files: string[];
  commit: string;
  base?: string;
  coverageNote?: string;
  title: string;
  partial: boolean;
}

export interface ChangeBrief {
  spans?: ConceptSpan[];
  conceptId: number;
  title: string;
  summary: string;
  what: string;
  why: string;
  mechanics: string | null;
  boundary: string | null;
  before: string;
  after: string;
  base?: string;
  coverageNote?: string;
  commit: string;
  files: string[];
  partial: boolean;
  trace: string[];
  excerpt: string[];
  touched: { id: number; title: string }[];
  recommendation: { conceptId: number; title: string; reason: string };
}

export interface LearnIntent {
  id: string;
  workspace: string;
  name?: string;
  source?: string;
  kind: 'pr' | 'commit' | 'proposed';
  ref: string;
}

export type GenerationResult = { kind: 'baseline' } | { kind: 'change'; brief: ChangeBrief };
export type SavedRequest = Omit<RepoRequest, 'selection'> & ChangeRef;

export type RepositoryInput = Exclude<AddWorkspaceInput, { kind: 'topic' }>;

export interface RepositoryContract {
  'repo:stage': { request: { source: RepositoryInput }; response: { workspace: Workspace; inventory: RepositoryInventory } };
  'repo:attach': { request: { token: string }; response: Workspace };
  'repo:files': { request: { workspaceId: string }; response: RepositoryInventory };
  'repo:preview': { request: RepoRequest; response: RepoPreview };
  'repo:generate': { request: { token: string; requestId: string }; response: GenerationResult };
  'repo:cancel': { request: { requestId: string }; response: boolean };
  'repo:changes': { request: { workspaceId: string }; response: { changes: (ChangeRef & { title: string })[]; warning: string | null } };
  'repo:history': { request: HistoryRequest; response: HistoryPage };
  'repo:detail': { request: DetailRequest; response: ChangeDetail };
  'repo:saved': { request: SavedRequest; response: ChangeBrief | null };
  'learn:pending': { request: null; response: LearnIntent | null };
  'learn:resolve': { request: { id: string; accept: boolean }; response: Workspace | null };
}
