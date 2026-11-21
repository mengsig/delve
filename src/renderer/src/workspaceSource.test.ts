import { describe, expect, it } from 'vitest';
import { workspaceInput } from './workspaceSource';

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
