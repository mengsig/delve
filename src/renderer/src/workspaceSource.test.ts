import { describe, expect, it } from 'vitest';
import { droppedSource, repositoryInput, workspaceInput } from './workspaceSource';

describe('setup source validation', () => {
  it('accepts GitHub URLs and the existing owner/name format', () => {
    expect(workspaceInput('github', ' https://github.com/Octo/re.po.git/ ')).toEqual({ kind: 'github', owner: 'Octo', repo: 're.po.git' });
    expect(workspaceInput('github', 'octo/project')).toEqual({ kind: 'github', owner: 'octo', repo: 'project' });
  });

  it.each(['', 'https://other.example/owner/repo', 'octo/site/pull/1', 'octo/.git', 'octo/..', 'octo/repo?tab=issues'])(
    'rejects ambiguous or invalid GitHub source %j', (source) => {
      expect(() => workspaceInput('github', source)).toThrow('Use a GitHub repository URL or owner/name');
    },
  );

  it('validates absolute folder paths before main checks the Git working tree', () => {
    for (const path of ['/work/delve', 'C:\\work\\delve', '\\\\server\\repos\\delve']) {
      expect(workspaceInput('git', path)).toEqual({ kind: 'git', path });
    }
    expect(() => workspaceInput('git', '~/work')).toThrow('absolute path');
    expect(() => workspaceInput('git', 'work/delve')).toThrow('absolute path');
  });

  it('normalizes a topic and checks its length after normalization', () => {
    expect(workspaceInput('topic', '  Film    photography ')).toEqual({ kind: 'topic', title: 'Film photography' });
    expect(() => workspaceInput('topic', '  ')).toThrow('Name the topic');
    expect(() => workspaceInput('topic', 'a'.repeat(121))).toThrow('120 characters');
  });
});

describe('shared repository field', () => {
  it.each([
    [' https://github.com/Octo/delve ', { kind: 'github', owner: 'Octo', repo: 'delve' }],
    ['octo/delve', { kind: 'github', owner: 'octo', repo: 'delve' }],
    ['/work/repo with spaces', { kind: 'git', path: '/work/repo with spaces' }],
    ['C:\\work\\delve', { kind: 'git', path: 'C:\\work\\delve' }],
    ['\\\\server\\repos\\delve', { kind: 'git', path: '\\\\server\\repos\\delve' }],
  ])('recognizes %j without a source tab', (value, expected) => {
    expect(repositoryInput(value)).toEqual(expected);
  });

  it.each(['octo/', 'https://github.com/octo/delve/pull/1', '/work\n/octo', '/work\0delve', '/' + 'a'.repeat(4096)])(
    'does not stage invalid or incomplete input %j', value => {
      expect(repositoryInput(value)).toBeUndefined();
    },
  );

  it('extracts a dragged URI or text', () => {
    expect(droppedSource('# browser\nhttps://github.com/octo/delve\r\n', '')).toBe('https://github.com/octo/delve');
    expect(droppedSource('', ' /work/delve ')).toBe('/work/delve');
    expect(droppedSource('file:///work/Delve%20Dev', '')).toBe('/work/Delve Dev');
    expect(droppedSource('file:///C:/work/Delve%20Dev', '')).toBe('C:/work/Delve Dev');
    expect(droppedSource('file://server/repos/delve', '')).toBe('\\\\server\\repos\\delve');
    expect(droppedSource('file:///work/%XX', '')).toBe('file:///work/%XX');
  });
});
