import type { KnowledgeConcept } from '../../../shared/knowledge';

export interface Point { id: number; x: number; y: number }

self.onmessage = (event: MessageEvent<KnowledgeConcept[]>) => {
  const groups = new Map<string, KnowledgeConcept[]>();
  for (const concept of event.data) {
    const key = concept.memberships[0]?.workspaceId ?? '';
    const group = groups.get(key) ?? [];
    group.push(concept);
    groups.set(key, group);
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(groups.size)));
  const points: Point[] = [];
  const cellSize = Math.max(260, ...[...groups.values()].map(group => Math.ceil(Math.sqrt(group.length)) * 110 + 100));
  [...groups.values()].forEach((group, groupIndex) => {
    const side = Math.ceil(Math.sqrt(group.length));
    const originX = (groupIndex % columns) * cellSize;
    const originY = Math.floor(groupIndex / columns) * cellSize;
    group.forEach((concept, index) => points.push({ id: concept.id,
      x: originX + (index % side) * 110, y: originY + Math.floor(index / side) * 80 }));
  });
  self.postMessage(points);
};
