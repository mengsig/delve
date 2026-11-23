import type { AddWorkspaceInput, WorkspaceKind } from '../../shared/domain';
import { IpcCallError } from './api';
import { workspaceInput } from './workspaceSource';

const SOURCE_ERROR_CODES = new Set(['INVALID_REQUEST', 'INVALID_WORKSPACE', 'NOT_A_GIT_REPOSITORY']);

/** The typed source itself was rejected, so the user should edit it. */
export class SourceError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = 'SourceError';
  }
}

/** Validates the typed source; any rejection becomes a SourceError. */
export function sourceInput(kind: WorkspaceKind, value: string): AddWorkspaceInput {
  try {
    return workspaceInput(kind, value);
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    throw new SourceError(cause.message, { cause });
  }
}

/** Marks a main-process rejection of the source as a SourceError; other failures pass through unchanged. */
export function sourceRejection(cause: unknown): unknown {
  if (!(cause instanceof IpcCallError) || !SOURCE_ERROR_CODES.has(cause.code)) return cause;
  return new SourceError(cause.message, { cause });
}

/** What happened to focus between submitting the form and the request settling. */
export interface FocusWatch { start: Element | null; moved: boolean }

/** Restores focus only if the user did not move it while the request ran and it still sits where submit left it. */
export function shouldFocusSource(watch: FocusWatch | null, active: Element | null, body: Element, source: Element | null) {
  if (!source || watch?.moved) return false;
  return active === null || active === body || active === source || (watch !== null && active === watch.start);
}
