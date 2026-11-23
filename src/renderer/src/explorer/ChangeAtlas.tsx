import { useCallback } from 'react';
import type { WorkspaceGraph } from '../../../shared/graph';
import { call } from '../api';
import { Atlas, type AtlasProps } from '../atlas/Atlas';
import { ReadState } from '../ReadState';
import { useRead } from '../useRead';
import { changeLabel } from './ChangeHeading';
import type { ChangeRef } from '../../../shared/repository';

export interface AtlasFocus {
  id: number;
  change?: ChangeRef;
}

function includeFocusedConcept(reviewed: WorkspaceGraph, change: WorkspaceGraph, id: number): WorkspaceGraph {
  if (reviewed.workspaceId !== change.workspaceId) throw new Error('The selected concept belongs to another workspace.');
  const concept = change.concepts.find(entry => entry.id === id);
  if (!concept) throw new Error('This concept is no longer available in the workspace.');
  const ids = new Set([...reviewed.concepts.map(entry => entry.id), id]);
  return { ...reviewed, concepts: [...reviewed.concepts, concept],
    evidence: [...reviewed.evidence, ...change.evidence.filter(entry => entry.conceptId === id)],
    edges: change.edges.filter(edge => ids.has(edge.conceptId) && ids.has(edge.prerequisiteId)) };
}

interface Props extends AtlasProps {
  focus?: AtlasFocus;
  onClearFocus: () => void;
}

function FocusedAtlas({ focus, onClearFocus, ...props }: Props & { focus: AtlasFocus }) {
  const { graph } = props;
  const query = useCallback(async () => {
    const all = await call('graph:read', { workspaceId: graph.workspaceId, includeChangeLessons: true });
    return includeFocusedConcept(graph, all, focus.id);
  }, [graph, focus.id]);
  const { result, refresh } = useRead(query);
  if (result.status !== 'ready') return <ReadState label="Selected concept" retry={refresh}
    message={result.status === 'error' ? result.message : undefined} />;
  return <><div className="atlas-focus"><p>Viewing a concept from {focus.change ? changeLabel(focus.change) : 'Knowledge'} alongside your reviewed map.</p>
    <button className="back" onClick={onClearFocus}>Return to reviewed map</button></div>
    <Atlas {...props} graph={result.value} initialConceptId={focus.id} /></>;
}

export function ChangeAtlas({ focus, ...props }: Props) {
  if (focus && !props.graph.concepts.some(entry => entry.id === focus.id)) return <FocusedAtlas {...props} focus={focus} />;
  return <Atlas {...props} initialConceptId={focus?.id ?? props.initialConceptId} />;
}
