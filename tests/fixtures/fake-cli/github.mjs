import { readFileSync } from 'node:fs';
const [fixture, ...argv] = process.argv.slice(2);
const { pr, files, signedOut, empty } = JSON.parse(readFileSync(fixture, 'utf8'));
const prefix = ['api', '--hostname', 'github.com', '--method', 'GET'];
if (argv.length !== 6 || prefix.some((arg, i) => argv[i] !== arg)) throw new Error('Expected one read-only GitHub API request');
if (signedOut) {
  process.stderr.write('Run gh auth login\n');
  process.exit(1);
}
const url = new URL(argv[5], 'https://fixture.invalid/');
const pulls = '/repos/contour/dispatch/pulls';
if (url.pathname === pulls) {
  const page = Number(url.searchParams.get('page') ?? 1);
  process.stdout.write(JSON.stringify(page === 1 && !empty ? [pr] : []));
} else if (url.pathname === pulls + '/42') {
  process.stdout.write(JSON.stringify(pr));
} else if (url.pathname === pulls + '/42/files') {
  process.stdout.write(JSON.stringify(files));
} else {
  throw new Error('Unexpected GitHub fixture endpoint');
}
