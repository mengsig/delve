import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppPath } from './protocol';
import { CONTENT_SECURITY_POLICY, isAppUrl } from './security';

describe('isAppUrl', () => {
  it('trusts only the app origin and, in development, the dev server origin', () => {
    expect(isAppUrl('app://delve/index.html', undefined)).toBe(true);
    expect(isAppUrl('app://other/index.html', undefined)).toBe(false);
    expect(isAppUrl('file:///etc/passwd', undefined)).toBe(false);
    expect(isAppUrl('https://example.com', undefined)).toBe(false);
    expect(isAppUrl('http://localhost:5173/x', 'http://localhost:5173/')).toBe(true);
    expect(isAppUrl('http://localhost:5174/x', 'http://localhost:5173/')).toBe(false);
    expect(isAppUrl('not a url', undefined)).toBe(false);
  });

  it('ships a CSP without inline or remote scripts', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline');
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
  });
});

describe('resolveAppPath', () => {
  const root = join('/', 'opt', 'delve', 'renderer');

  it('maps app URLs into the renderer folder', () => {
    expect(resolveAppPath(root, 'app://delve/')).toBe(join(root, 'index.html'));
    expect(resolveAppPath(root, 'app://delve/assets/a.js')).toBe(join(root, 'assets', 'a.js'));
  });

  it('refuses traversal and foreign hosts', () => {
    expect(resolveAppPath(root, 'app://delve/..%2F..%2Fsecret')).toBeNull();
    // The URL parser folds dot segments first, so this stays inside the root.
    expect(resolveAppPath(root, 'app://delve/%2e%2e/%2e%2e/etc/passwd')).toBe(join(root, 'etc', 'passwd'));
    expect(resolveAppPath(root, 'app://evil/index.html')).toBeNull();
  });
});
