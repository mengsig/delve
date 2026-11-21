import assert from 'node:assert';

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

export function validateModel(model: string): string {
  assert(typeof model === 'string', 'model must be a string');
  if (!MODEL_PATTERN.test(model)) throw new Error(`Invalid model name: ${JSON.stringify(model)}`);
  return model;
}

function modelArgs(model: string | undefined): string[] {
  return model === undefined ? [] : ['--model', validateModel(model)];
}

export function buildClaudeArgv(jsonSchema: Record<string, unknown>, model?: string): string[] {
  assert(typeof jsonSchema === 'object' && jsonSchema !== null, 'jsonSchema must be an object');
  const argv = [
    '-p', '--output-format', 'json',
    '--json-schema', JSON.stringify(jsonSchema),
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    ...modelArgs(model),
  ];
  assert(!argv.includes('-'), 'prompt must travel on stdin');
  return argv;
}

export interface CodexPaths {
  workDir: string;
  schemaFile: string;
  lastMessageFile: string;
}

export function buildCodexArgv(paths: CodexPaths, model?: string): string[] {
  assert(paths.workDir && paths.schemaFile && paths.lastMessageFile, 'codex paths must be non-empty');
  const argv = [
    'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral',
    '--ignore-user-config', '--ignore-rules',
    '--cd', paths.workDir,
    '--output-schema', paths.schemaFile,
    '--output-last-message', paths.lastMessageFile,
    ...modelArgs(model),
    '-',
  ];
  assert(argv[argv.length - 1] === '-', 'codex reads the prompt from stdin');
  return argv;
}
