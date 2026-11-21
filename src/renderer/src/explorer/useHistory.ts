import { useEffect, useState } from 'react';
import type { HistoryPage } from '../../../shared/explorer';
import type { ChangeRef } from '../../../shared/repository';
import { call, IpcCallError } from '../api';
import { changeKey } from './lanes';

export interface HistoryFilters {
  branch?: string;
  kind?: ChangeRef['kind'];
  author?: string;
  search?: string;
}

interface HistoryRequest { query: string; cursor: number; retried?: boolean; searchedPages?: number }
interface HistoryResult {
  request: HistoryRequest | null;
  page: HistoryPage | null;
  error: string | null;
  expired?: boolean;
}

const emptyResult: HistoryResult = { request: null, page: null, error: null };

function appendPage(previous: HistoryPage | null, incoming: HistoryPage, cursor: number): HistoryPage {
  if (cursor !== (previous ? previous.next : 0)) {
    throw new Error('History returned a page out of order.');
  }
  if (incoming.next !== null && (!Number.isSafeInteger(incoming.next) || incoming.next <= 0 || incoming.next === cursor)) {
    throw new Error('History returned an invalid next page.');
  }
  const nodes = new Map(previous?.nodes.map(node => [changeKey(node), node]));
  for (const node of incoming.nodes) {
    const key = changeKey(node);
    if (!nodes.has(key)) nodes.set(key, node);
  }
  const branches = [...new Set([...(previous?.branches ?? []), ...incoming.branches])];
  return { ...incoming, branches, nodes: [...nodes.values()] };
}

export function useHistory(workspaceId: string, filters: HistoryFilters, query: string) {
  const [request, setRequest] = useState<HistoryRequest>({ query, cursor: 0 });
  const [result, setResult] = useState(emptyResult);
  if (request.query !== query) {
    setRequest({ query, cursor: 0 });
    setResult(emptyResult);
  }
  const { branch, kind, author, search } = filters;
  const { page } = result;
  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const incoming = await call('repo:history', {
          workspaceId, cursor: request.cursor, branch, kind, author, search,
        });
        if (!current) return;
        const merged = appendPage(page, incoming, request.cursor);
        setResult({ request, page: merged, error: null });
        const searchedPages = request.searchedPages ?? 0;
        if ((search || author) && !merged.nodes.length && merged.next !== null && searchedPages < 9) {
          setRequest({ query: request.query, cursor: merged.next, searchedPages: searchedPages + 1 });
        }
      } catch (cause) {
        if (!current) return;
        const error = cause instanceof Error ? cause.message : String(cause);
        setResult({ request, page, error, expired: cause instanceof IpcCallError && cause.code === 'STALE_HISTORY' });
      }
    }
    if (request !== result.request) void load();
    return () => { current = false; };
  }, [workspaceId, request, result.request, page, branch, kind, author, search]);

  const loading = request !== result.request;
  function loadMore() {
    if (!loading && !result.error && page?.next != null) setRequest({ query, cursor: page.next });
  }
  function retry() {
    if (loading || !result.error) return;
    if (result.expired) refresh();
    else setRequest({ ...request, retried: true });
  }
  function refresh() {
    setResult(emptyResult);
    setRequest({ query, cursor: 0 });
  }
  return { refresh, page, loading, error: loading ? null : result.error, hasRequestedMore: request.cursor !== 0 || request.retried === true, loadMore, retry };
}
