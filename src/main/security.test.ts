import { join, parse, resolve, sep } from 'node:path';
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
  const root = resolve('/', 'opt', 'delve', 'renderer');

  it('maps app URLs into the renderer folder', () => {
    expect(resolveAppPath(root, 'app://delve/')).toBe(join(root, 'index.html'));
    expect(resolveAppPath(root, 'app://delve/assets/a.js')).toBe(join(root, 'assets', 'a.js'));
    expect(resolveAppPath(root, 'app://delve/..foo')).toBe(join(root, '..foo'));
  });

  it('refuses traversal and foreign hosts', () => {
    expect(resolveAppPath(root, 'app://delve/..%2F..%2Fsecret')).toBeNull();
    // The URL parser folds dot segments first, so this stays inside the root.
    expect(resolveAppPath(root, 'app://delve/%2e%2e/%2e%2e/etc/passwd')).toBe(join(root, 'etc', 'passwd'));
    expect(resolveAppPath(root, 'app://evil/index.html')).toBeNull();
    expect(resolveAppPath(root, 'app://delve/..%2Frenderer-other%2Fsecret')).toBeNull();
    expect(resolveAppPath(root, 'app://delve/%2e%2e%2f')).toBeNull();
  });

  it('normalizes the root before checking containment', () => {
    expect(resolveAppPath(`${root}${sep}..${sep}renderer${sep}`, 'app://delve/')).toBe(resolve(root, 'index.html'));
    expect(resolveAppPath(parse(root).root, 'app://delve/index.html')).toBe(resolve(parse(root).root, 'index.html'));
  });

  it.skipIf(process.platform !== 'win32')('handles root-relative and drive-letter Windows paths', () => {
    const rootRelative = `${sep}opt${sep}delve${sep}renderer`;
    for (const windowsRoot of [rootRelative, resolve(rootRelative), `${resolve(rootRelative)}${sep}`]) {
      expect(resolveAppPath(windowsRoot, 'app://delve/')).toBe(resolve(windowsRoot, 'index.html'));
      expect(resolveAppPath(windowsRoot, 'app://delve/..%5C..%5Csecret')).toBeNull();
      expect(resolveAppPath(windowsRoot, 'app://evil/index.html')).toBeNull();
    }
  });
});
