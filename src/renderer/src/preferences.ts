import { DEFAULT_DEPTH, DEPTHS, type Depth } from '../../shared/domain';

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
