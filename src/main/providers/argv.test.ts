import { describe, expect, it } from 'vitest';
import { buildClaudeArgv, buildCodexArgv } from './argv';

describe('argv builders', () => {
  it('builds the fixed claude argv', () => {
    expect(buildClaudeArgv({ type: 'object' }, 'sonnet')).toEqual([
      '-p', '--output-format', 'json', '--json-schema', '{"type":"object"}', '--tools', '',
      '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
      '--no-session-persistence', '--model', 'sonnet',
    ]);
  });

  it('builds the fixed codex argv', () => {
    expect(buildCodexArgv({ workDir: '/w', schemaFile: '/s.json', lastMessageFile: '/l.json' })).toEqual([
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
      '--ignore-rules', '--cd', '/w', '--output-schema', '/s.json', '--output-last-message', '/l.json', '-',
    ]);
  });

  it('rejects flag-like or malformed model names', () => {
    for (const bad of ['--help', '-x', 'a b', '', 'a;rm', 'x'.repeat(81)]) {
      expect(() => buildClaudeArgv({}, bad)).toThrow(/Invalid model/);
    }
  });
});
