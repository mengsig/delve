import { describe, expect, it } from 'vitest';
import type { HistoryNode } from '../../../shared/explorer';
import { layoutLanes, OVERFLOW_LANE } from './lanes';

function commit(ref: string, ...parents: string[]): HistoryNode {
  return { kind: 'commit', ref, title: ref, author: 'Delve', date: '', parents, branches: [], head: ref };
}

function pull(ref: string, head: string): HistoryNode {
  return { ...commit(ref, head), kind: 'pr', head, headBranch: 'feature', baseBranch: 'main' };
}

describe('layoutLanes', () => {
  it('keeps a merge on its first-parent track and reunites both tracks at the shared ancestor', () => {
    const rows = layoutLanes([
      commit('merge', 'first', 'second'), commit('first', 'root'),
      commit('second', 'root'), commit('root'),
    ], false);
    expect(rows.map(row => row.lane)).toEqual([0, 0, 1, 0]);
    expect(rows[0]?.segments).toContainEqual({ span: 'outgoing', from: 0, to: 1, pull: false });
    expect(rows[2]?.segments).toContainEqual({ span: 'outgoing', from: 1, to: 0, pull: false });
    expect(rows.every(row => row.collapsed === 0)).toBe(true);
  });

  it('connects pull requests to a visible head in either display order', () => {
    const rows = layoutLanes([pull('1', 'head'), commit('head'), pull('2', 'head')], false);
    expect(rows[0]?.segments).toContainEqual({ span: 'outgoing', from: 0, to: 0, pull: true });
    expect(rows[1]?.segments).toContainEqual({ span: 'incoming', from: 0, to: 0, pull: true });
    expect(rows[1]?.segments).toContainEqual({ span: 'outgoing', from: 0, to: 0, pull: true });
    expect(rows[2]?.segments).toContainEqual({ span: 'incoming', from: 0, to: 0, pull: true });
  });

  it('collapses busy histories into a bounded rail and clears it after their branches rejoin', () => {
    const branches = Array.from({ length: 35 }, (_, index) => 'branch-' + index);
    const rows = layoutLanes([
      commit('merge', ...branches), ...branches.map(branch => commit(branch, 'root')), commit('root'),
    ], false);
    expect(rows[0]?.collapsed).toBe(branches.length - OVERFLOW_LANE);
    expect(rows.slice(0, -1).every(row => row.lane <= OVERFLOW_LANE)).toBe(true);
    expect(rows.at(-1)).toMatchObject({ lane: 0, collapsed: 0 });
    expect(rows[0]?.segments.filter(segment => segment.to === OVERFLOW_LANE)).toHaveLength(1);
  });

  it('continues unresolved parents only when more history is available', () => {
    const nodes = [commit('tip', 'missing'), commit('side')];
    expect(layoutLanes(nodes, true)[1]).toMatchObject({
      lane: 1, segments: [{ span: 'through', from: 0, to: 0, pull: false }],
    });
    expect(layoutLanes(nodes, false)[0]?.segments).toEqual([{ span: 'stub', from: 0, to: 0, pull: false }]);
    expect(layoutLanes(nodes, false)[1]).toMatchObject({ lane: 0, segments: [] });
  });

  it('handles a commit parent that sorts above its child', () => {
    const rows = layoutLanes([commit('parent'), commit('child', 'parent')], false);
    expect(rows[0]?.segments).toContainEqual({ span: 'outgoing', from: 0, to: 0, pull: false });
    expect(rows[1]?.segments).toContainEqual({ span: 'incoming', from: 0, to: 0, pull: false });
  });
});
