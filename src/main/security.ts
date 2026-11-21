import assert from 'node:assert/strict';
import { STAGE_URL } from './instrument-origin';
import { app, session, type WebContents } from 'electron';

export const APP_SCHEME = 'app';
export const APP_HOST = 'delve';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src app://instrument/stage",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/** True when `url` belongs to the app itself: the packaged origin or, in development, the dev server. */
export function isAppUrl(url: string, devServerUrl: string | undefined): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // An unparseable URL is never trusted; callers treat false as "block".
  }
  if (parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST) return true;
  return devServerUrl !== undefined && parsed.origin === new URL(devServerUrl).origin;
}

function lockDownContents(contents: WebContents, devServerUrl: string | undefined): void {
  contents.on('will-frame-navigate', event => {
    if (!event.isMainFrame && (event.url !== STAGE_URL || event.initiator !== contents.mainFrame)) event.preventDefault();
  });
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, devServerUrl)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url, devServerUrl)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** Blocks navigation, new windows, webviews and every permission request, for all web contents. */
export function applySecurityPolicy(devServerUrl: string | undefined): void {
  assert.ok(app.isReady(), 'security policy needs the default session, available after ready');
  app.on('web-contents-created', (_event, contents) => lockDownContents(contents, devServerUrl));
  session.defaultSession.on('will-download', event => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  assert.ok(!app.isPackaged || devServerUrl === undefined, 'a packaged app never loads a dev server');
}
