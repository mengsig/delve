import assert from 'node:assert';
import { access, constants, readFile } from 'node:fs/promises';
import path from 'node:path';
import { findExecutable } from './which';

/** What to spawn, without a shell, to run a CLI found on PATH. */
export interface Command {
  file: string;
  prefixArgs: string[];
}

export type Resolution = { ok: true; command: Command } | { ok: false; problem: string };

export interface CmdShim {
  target: string;
  viaNode: boolean;
}

const MAX_SHIM_BYTES = 64 * 1024;

/**
 * Reads an npm cmd-shim launcher: `"%dp0%\<relative target>" %*`, run through node when it uses "%_prog%".
 * Returns null for anything else, since a .cmd cannot be spawned without a shell.
 */
export function parseCmdShim(content: string): CmdShim | null {
  assert(typeof content === 'string', 'shim content must be text');
  const matches = [...content.matchAll(/"%dp0%\\([^"%\r\n]+)"\s+%\*/g)];
  const target = matches.at(-1)?.[1];
  if (target === undefined || target.trim() === '') return null;
  return { target, viaNode: content.includes('"%_prog%"') };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    // access() signals a missing file by throwing
    return false;
  }
}

async function resolveShim(binPath: string, env: NodeJS.ProcessEnv): Promise<Resolution> {
  const content = await readFile(binPath, 'utf8');
  assert(content.length <= MAX_SHIM_BYTES, `launcher ${binPath} is too large to be an npm shim`);
  const shim = parseCmdShim(content);
  if (shim === null) return { ok: false, problem: `unsupported launcher script ${binPath}; install the CLI's native executable` };
  const dir = path.dirname(binPath);
  const target = path.join(dir, ...shim.target.split('\\'));
  if (!(await exists(target))) return { ok: false, problem: `launcher ${binPath} points to missing ${target}` };
  if (!shim.viaNode) {
    if (/\.exe$/i.test(target)) return { ok: true, command: { file: target, prefixArgs: [] } };
    return { ok: false, problem: `launcher ${binPath} runs ${target}, which is not an executable` };
  }
  const bundledNode = path.join(dir, 'node.exe');
  const node = (await exists(bundledNode)) ? bundledNode : await findExecutable('node', env);
  if (node === null) return { ok: false, problem: `launcher ${binPath} needs Node.js, which is not on PATH` };
  return { ok: true, command: { file: node, prefixArgs: [target] } };
}

/** Turns a PATH hit into a spawnable command; npm .cmd launchers on Windows are run through node directly. */
export async function resolveCommand(binPath: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<Resolution> {
  assert(path.isAbsolute(binPath), `executable path must be absolute: ${binPath}`);
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(binPath)) return { ok: true, command: { file: binPath, prefixArgs: [] } };
  const resolution = await resolveShim(binPath, env);
  assert(!resolution.ok || path.isAbsolute(resolution.command.file), 'resolved command must be absolute');
  return resolution;
}
