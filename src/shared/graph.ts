import type { ChangeRef } from './repository';
import type { Depth } from './domain';

export interface GraphConcept {
  id: number;
  key: string;
  title: string;
  summary: string;
  portable: boolean;
}

export interface GraphEdge {
  conceptId: number;
  prerequisiteId: number;
}

export interface GraphEvidence {
  conceptId: number;
  depth: Depth;
  status: 'demonstrated' | 'partial' | 'revisit';
  source: 'check' | 'environment' | 'self-report';
  note: string;
  workspaceId: string | null;
  workspaceName: string | null;
  revision: number;
  recordedAt: string;
}

export interface WorkspaceGraph {
  workspaceId: string;
  concepts: GraphConcept[];
  edges: GraphEdge[];
  evidence: GraphEvidence[];
  snapshot: string | null;
  baselineCommit?: string;
  demo: boolean;
  atlasConceptIds?: number[];
  changeSuggestions?: Partial<Record<Depth, ChangeRef & { title: string; reason: string }>>;
  suggestions?: Partial<Record<Depth, { conceptId: number; reason: string }>>;
  progress?: WorkspaceProgress;
}

export interface SavedCheckProgress {
  conceptId: number;
  snapshot: string | null;
  lessonRevision: string | null;
  masteryRevision: string;
  streak: number;
  attempted: boolean;
}

export interface WorkspaceProgress {
  depth: Depth;
  checks: SavedCheckProgress[];
}

export type WorkspaceHead =
  | { kind: 'topic' | 'demo' | 'unavailable' }
  | { kind: 'branch'; branch: string; cached: boolean }
  | { kind: 'detached'; commit: string; cached: boolean };

export interface WorkspaceCoverage {
  workspaceId: string;
  total: number;
  known: Record<Depth, number>;
}
