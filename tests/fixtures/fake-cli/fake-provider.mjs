#!/usr/bin/env node
// Fake claude/codex CLI. Behaviour: FAKE_PROVIDER_MODE; recording: FAKE_PROVIDER_RECORD; counter: FAKE_PROVIDER_COUNTER.
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
  if (invokedAs === 'claude') {
    console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' }));
    return;
  }
  if (loggedIn) console.log('Logged in using ChatGPT');
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

async function main() {
  if (argv[0] === '--version') return console.log(`fake-${invokedAs} 1.0.0`);
  if (argv[0] === 'auth' || argv[0] === 'login') return handleStatus();

  const stdin = await readStdin();
  if (process.env.FAKE_PROVIDER_RECORD) {
    const record = { argv, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), envKeys: Object.keys(process.env), stdin };
    fs.writeFileSync(process.env.FAKE_PROVIDER_RECORD, JSON.stringify(record));
  }
  if (process.env.FAKE_PROVIDER_COUNTER) bump(process.env.FAKE_PROVIDER_COUNTER);

  if (mode === 'hang') return setInterval(() => undefined, 1000);
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
