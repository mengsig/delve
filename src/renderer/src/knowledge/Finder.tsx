import { useState } from 'react';
import type { KnowledgeConcept } from '../../../shared/knowledge';
import { stateLabels } from './areas';
import type { Filters } from './view';

interface Props {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  matches: KnowledgeConcept[];
  select: (concept: KnowledgeConcept) => void;
  reset: () => void;
}

export function Finder({ filters, update, matches, select, reset }: Props) {
  return <section className="knowledge-finder" aria-label="Find a concept">
    <div className="knowledge-filters">
      <label>Search <input autoFocus type="search" value={filters.query} placeholder="Search names and descriptions"
        onChange={e => update({ query: e.target.value })} /></label>
      <label>State <select value={filters.state} onChange={e => update({ state: e.target.value })}>
        <option value="">All states</option>
        {Object.entries(stateLabels).map(([state, name]) => <option key={state} value={state}>{name}</option>)}
        <option value="verified">Mastered at any depth</option><option value="skipped">Previously skipped</option><option value="unstarted">Not started</option>
      </select></label>
      <label>Verified depth <select value={filters.depth} onChange={e => update({ depth: e.target.value })}>
        <option value="">All depths</option><option value="high">High level</option>
        <option value="medium">Medium</option><option value="low">Deep</option>
      </select></label>
      {(filters.query || filters.depth || filters.state) && <button onClick={reset}>Clear filters</button>}
    </div>
    <MatchList key={[filters.workspace, filters.query, filters.state, filters.depth, matches.length].join('|')} matches={matches} select={select} />
  </section>;
}

function MatchList({ matches, select }: Pick<Props, 'matches' | 'select'>) {
  const [page, setPage] = useState(0);
  const size = 12;
  return <div className="knowledge-matches" aria-label="Matching concepts">
    <span role="status">{matches.length} {matches.length === 1 ? 'match' : 'matches'}</span>
    {matches.slice(page * size, (page + 1) * size).map(c => <button key={c.id} onClick={() => select(c)}>{c.title}</button>)}
    {matches.length > size && <div className="match-pages">
      <button disabled={!page} onClick={() => setPage(page - 1)}>Previous matches</button>
      <button disabled={(page + 1) * size >= matches.length} onClick={() => setPage(page + 1)}>Next matches</button>
    </div>}
  </div>;
}
