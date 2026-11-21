import type { ChangeRef } from './repository';

export interface HistoryNode extends ChangeRef {
  title: string;
  author: string;
  date: string;
  parents: string[];
  branches: string[];
  head: string;
  baseBranch?: string;
  headBranch?: string;
  state?: 'open' | 'closed' | 'merged';
}

export interface HistoryPage {
  nodes: HistoryNode[];
  branches: string[];
  next: number | null;
  warning: string | null;
  pullStatus: 'available' | 'empty' | 'unavailable' | 'local' | 'unchecked';
}

export interface HistoryRequest {
  workspaceId: string;
  cursor: number;
  branch?: string;
  kind?: ChangeRef['kind'];
  author?: string;
  search?: string;
}

export interface DetailRequest extends ChangeRef {
  workspaceId: string;
}

export interface ChangeDetail {
  node: HistoryNode;
  base?: string;
  description?: string;
  files: { path: string; patch: string | null }[];
  fileCount: number;
  additions: number;
  deletions: number;
  savedOnly?: boolean;
  statsCoverage?: 'lower-bound' | 'unavailable';
  partial: boolean;
  coverageNote?: string;
  closedAt?: string;
  mergedAt?: string;
}
