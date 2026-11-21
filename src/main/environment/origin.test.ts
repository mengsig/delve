import { expect, it } from 'vitest';
import { instrumentResponse, STAGE_URL } from '../instrument-origin';

it('serves a sandboxed stage with fixed script and style resources', async () => {
  const response = await instrumentResponse('.', STAGE_URL, 'app://delve');
  const csp = response.headers.get('content-security-policy')!;
  expect(csp.split('; ')).toEqual(expect.arrayContaining([
    'sandbox allow-scripts', "default-src 'none'", "connect-src 'none'", "form-action 'none'", 'frame-ancestors app://delve',
  ]));
  expect(csp).not.toMatch(/allow-same-origin|unsafe-inline|allow-downloads|allow-top-navigation/);
  expect(await response.text()).toContain('app://instrument/stage.js');
  for (const other of ['/index.html', '/preload/index.js', '/../../delve.sqlite', '/stage?entry=abc']) {
    expect((await instrumentResponse('.', 'app://instrument' + other, 'app://delve')).status).toBe(404);
  }
});
