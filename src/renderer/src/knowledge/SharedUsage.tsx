import type { KnowledgeConcept } from '../../../shared/knowledge';

export function SharedMarker({ concept }: { concept: KnowledgeConcept }) {
  if (!concept.portable) return null;
  return <span className="knowledge-shared">Shared across repositories</span>;
}

export function UsedIn({ concept }: { concept: KnowledgeConcept }) {
  if (!concept.portable || !concept.memberships.length) return null;
  return <section aria-label="Used in">
    <h4>Used in</h4>
    <ul>{concept.memberships.map(workspace => <li key={workspace.workspaceId}>{workspace.workspaceName}</li>)}</ul>
  </section>;
}
