import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { protocol } from 'electron';
import { instrumentResponse } from './instrument-origin';
import { APP_HOST, APP_ORIGIN, APP_SCHEME, CONTENT_SECURITY_POLICY } from './security';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Must run before `app` is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

/** Maps an app:// URL to a file inside `root`, or null when it points anywhere else. */
export function resolveAppPath(root: string, url: string): string | null {
  assert.ok(isAbsolute(root), 'renderer root must be absolute');
  const parsed = new URL(url);
  if (parsed.host !== APP_HOST) return null;
  const pathname = decodeURIComponent(parsed.pathname);
  const normalizedRoot = resolve(root);
  const file = resolve(normalizedRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
  assert.ok(isAbsolute(file), 'resolved renderer file must be absolute');
  const pathFromRoot = relative(normalizedRoot, file);
  if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) return null;
  return file;
}

/** Serves the built renderer from `root` with a strict CSP header. */
export function serveRenderer(root: string, devServerUrl?: string): void {
  const parent = devServerUrl ? new URL(devServerUrl).origin : APP_ORIGIN;
  protocol.handle(APP_SCHEME, async (request) => {
    if (new URL(request.url).hostname === 'instrument') return instrumentResponse(join(root, '../instrument'), request.url, parent);
    const file = resolveAppPath(root, request.url);
    if (!file) return new Response('Forbidden', { status: 403 });
    const type = MIME_TYPES[extname(file)];
    if (!type) return new Response('Unsupported type', { status: 415 });
    try {
      const body = await readFile(file);
      return new Response(body, { headers: { 'content-type': type, 'content-security-policy': CONTENT_SECURITY_POLICY } });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response('Not found', { status: 404 });
      throw new Error(`Could not read renderer asset ${file}`, { cause: error });
    }
  });
}
