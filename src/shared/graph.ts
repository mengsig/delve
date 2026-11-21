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
  demo: boolean;
  suggestions?: Partial<Record<Depth, { conceptId: number; reason: string }>>;
}

export interface WorkspaceCoverage {
  workspaceId: string;
  total: number;
  known: Record<Depth, number>;
}
