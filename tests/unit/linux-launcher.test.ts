import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.platform !== 'linux')('packaged Linux launcher', () => {
  let directory: string;
  let launcher: string;
  let server: Server;
  let socket: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'delve-launcher-'));
    launcher = join(directory, 'delve');
    socket = join(directory, 'wayland-0');
    copyFileSync(new URL('../../scripts/linux-launcher.sh', import.meta.url), launcher);
    chmodSync(launcher, 0o755);
    writeFileSync(launcher + '.bin', '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    server = createServer();
    await once(server.listen(socket), 'listening');
  });

  afterAll(async () => {
    try {
      if (server?.listening) await once(server.close(), 'close');
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['Wayland without DISPLAY or session type', { WAYLAND_DISPLAY: 'wayland-0' }, 'wayland'],
    ['Wayland without DISPLAY despite stale session type', { XDG_SESSION_TYPE: 'x11' }, 'wayland'],
    ['Wayland with stale local X11 display', { DISPLAY: ':59999', XDG_SESSION_TYPE: 'x11' }, 'wayland'],
    ['X11 despite stale Wayland session type', { DISPLAY: 'host:5', WAYLAND_DISPLAY: 'missing', XDG_SESSION_TYPE: 'wayland' }, 'x11'],
    ['X11 desktop when both displays are present', { DISPLAY: 'host:5', XDG_SESSION_TYPE: 'x11' }, 'x11'],
  ] as const)('selects the compositor for %s and passes the link', (_scenario, env, platform) => {
    const link = 'delve://learn?workspace=octo/site&pr=184';
    const result = spawnSync(launcher, [link], { env: { XDG_RUNTIME_DIR: directory, ...env }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toEqual([`--ozone-platform=${platform}`, link]);
  });

  it('preserves an explicit Ozone platform', () => {
    const result = spawnSync(launcher, ['--ozone-platform=x11'], { env: {}, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('--ozone-platform=x11');
  });

  it('reports a missing display without running Electron', () => {
    const result = spawnSync(launcher, [], { env: { XDG_RUNTIME_DIR: directory, WAYLAND_DISPLAY: 'missing' }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Delve requires a graphical session.');
  });

  it('reports a stale local X11 display without running Electron', () => {
    const result = spawnSync(launcher, [], { env: { DISPLAY: ':59999', WAYLAND_DISPLAY: '' }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Delve requires a graphical session.');
  });
});
