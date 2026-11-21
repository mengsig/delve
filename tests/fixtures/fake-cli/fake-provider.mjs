#!/usr/bin/env node
// Fake claude/codex CLI. Behaviour: FAKE_PROVIDER_MODE; recording: FAKE_PROVIDER_RECORD, FAKE_PROVIDER_SELF_PID;
// counter: FAKE_PROVIDER_COUNTER.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const invokedAs = process.env.FAKE_PROVIDER_NAME ?? 'claude';
const mode = process.env.FAKE_PROVIDER_MODE ?? 'ok';
const payload = process.env.FAKE_PROVIDER_PAYLOAD ?? '{"answer":"42"}';

function bump(file) {
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
  fs.writeFileSync(file, String(n));
  return n;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

function handleStatus() {
  const loggedIn = mode !== 'signed-out';
  const apiKey = mode === 'api-key';
  if (invokedAs === 'claude') {
    console.log(JSON.stringify({ loggedIn, authMethod: apiKey ? 'api_key' : loggedIn ? 'claude.ai' : 'none' }));
    return;
  }
  if (apiKey) console.log('Logged in using an API key - sk-proj-***');
  else if (loggedIn) console.log('Logged in using ChatGPT');
  else {
    console.error('Not logged in');
    process.exitCode = 1;
  }
}

function succeed() {
  const text = mode === 'invalid' ? '{"wrong":true}' : payload;
  if (invokedAs === 'claude') {
    console.log(JSON.stringify({ type: 'result', is_error: false, subtype: 'success', result: '', structured_output: JSON.parse(text) }));
    return;
  }
  const idx = argv.indexOf('--output-last-message');
  fs.writeFileSync(argv[idx + 1], text);
  console.log('done');
}

// A grandchild left behind by the CLI. A detached one starts its own session (setsid on POSIX)
// and holds no pipes, like a daemonised helper; otherwise it inherits stdout/stderr.
function spawnDescendant(detached) {
  const stdio = detached ? 'ignore' : ['ignore', 'inherit', 'inherit'];
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio, detached });
  fs.writeFileSync(process.env.FAKE_PROVIDER_CHILD_PID, String(child.pid));
  child.unref();
}

function flood() {
  process.on('SIGTERM', () => undefined);
  const chunk = 'x'.repeat(64 * 1024);
  const write = () => process.stdout.write(chunk, write);
  write();
}

async function main() {
  if (argv[0] === '--version') return console.log(`fake-${invokedAs} 1.0.0`);
  if (argv[0] === 'auth' || argv[0] === 'login') return handleStatus();

  if (process.env.FAKE_PROVIDER_SELF_PID) fs.writeFileSync(process.env.FAKE_PROVIDER_SELF_PID, String(process.pid));
  const stdin = await readStdin();
  if (process.env.FAKE_PROVIDER_RECORD) {
    const record = { argv, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), envKeys: Object.keys(process.env), stdin };
    fs.writeFileSync(process.env.FAKE_PROVIDER_RECORD, JSON.stringify(record));
  }
  if (process.env.FAKE_PROVIDER_COUNTER) bump(process.env.FAKE_PROVIDER_COUNTER);

  if (mode === 'hang') return setInterval(() => undefined, 1000);
  if (mode === 'flood') return flood();
  if (['orphan', 'orphan-hang', 'detached', 'detached-hang'].includes(mode)) spawnDescendant(mode.startsWith('detached'));
  if (mode.endsWith('-hang')) return setInterval(() => undefined, 1000);
  const delay = Number(process.env.FAKE_PROVIDER_DELAY_MS ?? 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (mode === 'auth') {
    console.error('Error: Not logged in. Please run /login');
    process.exitCode = 1;
    return;
  }
  if (mode === 'quota') {
    console.error('Usage limit reached. Try again later.');
    process.exitCode = 1;
    return;
  }
  if (mode === 'fail-once' && bump(`${process.env.FAKE_PROVIDER_COUNTER}.once`) === 1) {
    console.error('transient glitch');
    process.exitCode = 1;
    return;
  }
  succeed();
}

main();
