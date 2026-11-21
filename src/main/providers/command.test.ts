import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCmdShim, resolveCommand } from './command';
import { makeTempDir } from './test-helpers';

const NPM_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n');

describe('parseCmdShim', () => {
  it('reads the target of an npm cmd-shim that runs through node', () => {
    expect(parseCmdShim(NPM_SHIM)).toEqual({ target: 'node_modules\\@anthropic-ai\\claude-code\\cli.js', viaNode: true });
  });

  it('reads a shim that runs an executable directly, and rejects other scripts', () => {
    expect(parseCmdShim('@"%dp0%\\..\\codex\\bin\\codex.exe" %*')).toEqual({ target: '..\\codex\\bin\\codex.exe', viaNode: false });
    expect(parseCmdShim('@echo off\r\ncall something.bat %*')).toBeNull();
    expect(parseCmdShim('"%dp0%\\%EVIL%\\x.js" %*')).toBeNull();
  });
});

describe('resolveCommand', () => {
  it('passes executables through unchanged off Windows', async () => {
    expect(await resolveCommand('/usr/bin/claude', {}, 'linux')).toEqual({ ok: true, command: { file: '/usr/bin/claude', prefixArgs: [] } });
    await expect(resolveCommand('relative/claude', {}, 'linux')).rejects.toThrow(/absolute/);
  });

  it('resolves an npm launcher to node plus the script, preferring a bundled node.exe', async () => {
    const dir = await makeTempDir('shim');
    const script = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, '');
    await writeFile(path.join(dir, 'claude.cmd'), NPM_SHIM);
    const viaPath = await resolveCommand(path.join(dir, 'claude.cmd'), { PATH: path.dirname(process.execPath) }, 'win32');
    expect(viaPath).toMatchObject({ ok: true, command: { prefixArgs: [script] } });
    await writeFile(path.join(dir, 'node.exe'), '');
    const bundled = await resolveCommand(path.join(dir, 'claude.cmd'), {}, 'win32');
    expect(bundled).toEqual({ ok: true, command: { file: path.join(dir, 'node.exe'), prefixArgs: [script] } });
  });

  it('explains why an unsupported or broken launcher cannot run', async () => {
    const dir = await makeTempDir('shim');
    await writeFile(path.join(dir, 'odd.cmd'), '@echo off\r\nstart claude %*');
    await writeFile(path.join(dir, 'broken.cmd'), NPM_SHIM);
    expect(await resolveCommand(path.join(dir, 'odd.cmd'), {}, 'win32')).toMatchObject({ ok: false, problem: expect.stringMatching(/unsupported launcher/) });
    expect(await resolveCommand(path.join(dir, 'broken.cmd'), {}, 'win32')).toMatchObject({ ok: false, problem: expect.stringMatching(/missing/) });
  });
});
