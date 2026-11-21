import type { Depth } from './domain';

export type MasteryState = 'verified' | 'in-progress' | 'skipped' | 'not-started';

export interface KnowledgeMembership {
  workspaceId: string;
  workspaceName: string;
}

export interface KnowledgeConcept {
  id: number;
  key: string;
  title: string;
  summary: string;
  portable: boolean;
  /** Workspaces that use the concept, ordered by name then id. */
  memberships: KnowledgeMembership[];
  /** Deepest depth with verified mastery, or null when none. */
  masteredDepth: Depth | null;
  /** verified: verified evidence exists; in-progress: a guided lesson is underway; skipped: only skipped lessons. */
  masteryState: MasteryState;
  /** Revision of the evidence record at masteredDepth, or null when not verified. */
  evidenceRevision: number | null;
  /** When mastery was first verified (earliest verified evidence), or null. */
  learnedAt: string | null;
  /** True when the concept is used by two or more workspaces. */
  bridge: boolean;
}

export interface KnowledgeEdge {
  conceptId: number;
  prerequisiteId: number;
}

export interface TransferLink {
  id: number;
  fromConceptId: number;
  toConceptId: number;
  reason: string;
  provider: string;
  model: string;
  /** Workspace the link was proposed from; null once that workspace is removed. */
  workspaceId: string | null;
  createdAt: string;
}

export interface TransferLinkInput {
  fromConceptId: number;
  toConceptId: number;
  reason: string;
  provider: string;
  model: string;
  workspaceId?: string;
}

export interface GlobalKnowledgeGraph {
  concepts: KnowledgeConcept[];
  edges: KnowledgeEdge[];
  links: TransferLink[];
}
