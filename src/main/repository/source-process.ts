import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { delimiter, dirname, isAbsolute } from 'node:path';
import { DomainError } from '../../shared/errors';
import { findExecutable } from '../providers/which';

const PROCESS_ENV = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'];
const GITHUB_ENV = ['GH_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
const GIT_NULL_FILE = '/dev/null';

function commandEnv(authenticated: boolean): NodeJS.ProcessEnv {
  const { PATH, Path } = process.env;
  const dirs = (PATH ?? Path ?? '').split(delimiter).filter(isAbsolute);
  const env: NodeJS.ProcessEnv = {
    PATH: dirs.join(delimiter),
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: GIT_NULL_FILE,
    GIT_CONFIG_GLOBAL: GIT_NULL_FILE,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: GIT_NULL_FILE,
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: authenticated ? 'https' : '',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
  };
  for (const name of [...PROCESS_ENV, ...(authenticated ? GITHUB_ENV : [])]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  assert.ok(dirs.every(isAbsolute));
  assert.equal(env.GIT_CONFIG_GLOBAL, GIT_NULL_FILE);
  return env;
}

interface CommandOptions {
  maxBytes?: number;
  timeoutMs?: number;
  authenticated?: boolean;
  cwd?: string;
}

export interface CommandResult {
  output: Buffer;
  truncated: boolean;
  status: number;
  diagnostic: string;
}

export async function sourceCommand(bin: 'git' | 'gh', args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const { maxBytes = 1024 * 1024, timeoutMs = 8_000, authenticated = false, cwd = dirname(process.execPath) } = options;
  assert.ok(maxBytes > 0 && timeoutMs > 0);
  assert.ok(isAbsolute(cwd));
  const env = commandEnv(authenticated);
  const executable = await findExecutable(bin, env);
  if (!executable) {
    const help = bin === 'gh' ? 'Install GitHub CLI and run gh auth login.' : 'Install Git to read repository snapshots.';
    throw new DomainError(bin === 'gh' ? 'GITHUB_CLI_REQUIRED' : 'GIT_REQUIRED', help);
  }
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      cwd, env, maxBuffer: maxBytes, timeout: timeoutMs, encoding: 'buffer', shell: false, windowsHide: true,
      killSignal: 'SIGKILL',
    }, (error, output, stderr) => {
      const diagnostic = stderr.toString('utf8');
      if (!error) return resolve({ output, diagnostic, status: 0, truncated: false });
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return resolve({ output, diagnostic, status: 0, truncated: true });
      }
      if (typeof error.code === 'number' && !error.killed) {
        return resolve({ output, diagnostic, status: error.code, truncated: false });
      }
      // Process errors can include argv and captured stderr. Keep diagnostics out of user-facing errors.
      reject(new DomainError('SOURCE_COMMAND_FAILED', error.killed
        ? `${bin} stopped before completing the repository read.`
        : `Could not start ${bin} to read the repository.`));
    });
  });
}

const GIT_SAFETY = ['--no-pager', '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false',
  '-c', `core.attributesFile=${GIT_NULL_FILE}`, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
  '-c', 'diff.suppressBlankEmpty=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=never'];

export function gitSource(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return sourceCommand('git', [...GIT_SAFETY, ...args], options);
}

export function completedOutput(result: CommandResult, message: string): Buffer {
  if (result.truncated) throw new DomainError('SOURCE_LIMIT', 'Repository output exceeded the read limit.');
  if (result.status !== 0) throw new DomainError('SOURCE_READ_FAILED', message);
  return result.output;
}
