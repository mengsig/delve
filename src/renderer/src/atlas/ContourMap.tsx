import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseEdge, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, useViewport,
  type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import type { Depth } from '../../../shared/domain';
import { DEPTHS } from '../../../shared/domain';
import { Terrain } from '../Terrain';
import type { DemoPlate } from './demoAtlas';
import { positions } from './layout';
import { isLearned, statusText, type AtlasConcept, type AtlasModel } from './model';
import './atlas.css';

interface MapProps {
  model: AtlasModel;
  demo?: DemoPlate;
  workspaceId: string;
  name: string;
  depth: Depth;
  selected: AtlasConcept;
  recommendedId?: number;
  onSelect: (id: number) => void;
}

type ConceptNode = Node<{
  concept: AtlasConcept;
  active: boolean;
  recommended: boolean;
  changed: boolean;
  status: string;
  onSelect: (id: number) => void;
}, 'concept'>;

function motionDuration() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
}

function revealNode(button: HTMLButtonElement, id: number, flow: ReactFlowInstance<ConceptNode>) {
  if (!button.matches(':focus-visible')) return;
  const canvas = button.closest('.atlas-canvas')?.getBoundingClientRect();
  const node = flow.getNode(String(id));
  if (!canvas || !node) return;
  const rect = button.getBoundingClientRect();
  if (rect.left >= canvas.left && rect.right <= canvas.right && rect.top >= canvas.top && rect.bottom <= canvas.bottom) return;
  void flow.setCenter(node.position.x, node.position.y, { zoom: flow.getZoom(), duration: motionDuration() });
}

function ConceptMarker({ data }: NodeProps<ConceptNode>) {
  const flow = useReactFlow<ConceptNode>();
  const { concept, active, changed, status, recommended, onSelect } = data;
  const known = isLearned(concept);
  const state = known ? 'known' : changed ? 'changed' : 'missing';
  const symbol = known ? '✓' : changed ? '∆' : active ? '◎' : '·';
  return <>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <button type="button" className={'node nodrag nopan ' + state + (active ? ' selected' : '') + (recommended && !active ? ' next' : '')}
      aria-label={concept.title + ', ' + status + (recommended ? ', Recommended next' : '')} aria-pressed={active}
      onFocus={event => revealNode(event.currentTarget, concept.id, flow)} onClick={() => onSelect(concept.id)}>
      <i aria-hidden="true">{symbol}</i><span>{concept.title}</span>
    </button>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </>;
}

function DependencyEdge({ sourceX, sourceY, targetX, targetY }: EdgeProps) {
  const distance = targetX - sourceX;
  const path = `M${sourceX} ${sourceY} C${sourceX + distance * .45} ${sourceY}, ${targetX - distance * .3} ${targetY}, ${targetX} ${targetY}`;
  return <BaseEdge path={path} />;
}

const edgeTypes = { dependency: DependencyEdge };
const nodeTypes = { concept: ConceptMarker };
const minZoom = .1;
const maxZoom = 2.5;

function MapControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return <div className="atlas-map-tools" role="group" aria-label="Map controls">
    <button aria-label="Zoom out" title="Zoom out" disabled={zoom <= minZoom} onClick={() => void zoomOut({ duration: motionDuration() })}>−</button>
    <button aria-label="Zoom in" title="Zoom in" disabled={zoom >= maxZoom} onClick={() => void zoomIn({ duration: motionDuration() })}>+</button>
    <button aria-label="Fit map" title="Fit map" onClick={() => void fitView({ padding: .23, maxZoom: 1, duration: motionDuration() })}>Fit</button>
  </div>;
}

function flowEdges(model: AtlasModel, selected: number): Edge[] {
  const edges: Edge[] = [];
  for (const concept of model.byId.values()) {
    for (const prior of concept.prerequisites) {
      const active = concept.id === selected || prior.id === selected;
      edges.push({
        id: prior.id + '-' + concept.id, source: String(prior.id), target: String(concept.id),
        ariaLabel: prior.title + ' is a prerequisite for ' + concept.title,
        type: 'dependency', className: active ? 'atlas-edge-active' : 'atlas-edge',
      });
    }
  }
  return edges;
}

function FlowCanvas({ model, demo, workspaceId, selected, recommendedId, onSelect }: MapProps) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const points = useMemo(() => size.width && size.height
    ? positions(model, size.width, size.height, demo) : null, [model, demo, size]);
  const nodes = useMemo<ConceptNode[]>(() => Array.from(points ?? [], ([id, position]) => {
    const concept = model.byId.get(id);
    if (!concept) throw new Error('A map position has no matching concept.');
    const changed = concept.id === demo?.changed?.id;
    return {
      id: String(id), type: 'concept', position, width: 30, height: 30,
      data: { concept, active: id === selected.id, changed, recommended: id === recommendedId, status: statusText(concept, workspaceId, changed), onSelect },
    };
  }), [points, model, selected.id, recommendedId, onSelect, demo, workspaceId]);
  const edges = useMemo(() => flowEdges(model, selected.id), [model, selected.id]);
  return <div className="atlas-canvas" ref={container}>
    {points && <ReactFlow<ConceptNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      nodeOrigin={[.5, .5]} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
      nodesFocusable={false} edgesFocusable={false} deleteKeyCode={null} selectionKeyCode={null}
      fitView={!demo} fitViewOptions={{ padding: .23, maxZoom: 1 }} minZoom={minZoom} maxZoom={maxZoom}
      aria-label="Concept dependency map" />}
  </div>;
}

export function ContourMap(props: MapProps) {
  const { model, name, demo, depth } = props;
  const plate = demo?.order.includes('exposure') ? '02' : '01';
  return <ReactFlowProvider><section className="mapbox" aria-label={name + ' terrain'}>
    <Terrain />
    <div className="maphead">
      <div><span className="map-label">Plate {plate} / Dependency map</span><b>{name} terrain</b></div>
      <div className="atlas-map-meta"><span className="coord">{model.byId.size} nodes &nbsp; / &nbsp; N ↑</span>
        <MapControls /></div>
    </div>
    <FlowCanvas {...props} />
    <div className="mapfoot">
      <div className="legend">
        <span><i className="dot known" />Learned</span><span><i className="dot" />Missing</span>
        <span><i className="dot sel" />Selected</span>{demo?.changed && <span><i className="dot change" />Changed</span>}
      </div><span className="coord">{DEPTHS.indexOf(depth) + 1} : 03 &nbsp; / &nbsp; {depth}</span>
    </div>
  </section></ReactFlowProvider>;
}
