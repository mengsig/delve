import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

export const STAGE_URL = 'app://instrument/stage';
const header = {
  'content-security-policy': [
    "sandbox allow-scripts", "default-src 'none'", "script-src app://instrument/stage.js 'wasm-unsafe-eval'",
    "style-src app://instrument/stage.css", "connect-src 'none'", "base-uri 'none'",
    "form-action 'none'", "object-src 'none'", "worker-src blob:",
  ].join('; '),
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), fullscreen=(), usb=(), serial=(), hid=(), payment=(), clipboard-read=(), clipboard-write=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const stage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="app://instrument/stage.css"><title>Delve instrument</title>
<script defer src="app://instrument/stage.js"></script></head><body><main></main></body></html>`;

export async function instrumentResponse(root: string, url: string, parentOrigin: string): Promise<Response> {
  const policy = header['content-security-policy'] + '; frame-ancestors ' + parentOrigin;
  if (url === STAGE_URL) return new Response(stage, { headers: { ...header, 'content-security-policy': policy, 'content-type': 'text/html; charset=utf-8' } });
  const script = url === STAGE_URL + '.js';
  if (!script && url !== STAGE_URL + '.css') return new Response('Unknown instrument resource', { status: 404 });
  const file = script ? 'stage.js' : 'stage.css';
  const data = await readFile(join(root, file));
  return new Response(data, { headers: { ...header, 'access-control-allow-origin': '*',
    'content-type': script ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' } });
}
