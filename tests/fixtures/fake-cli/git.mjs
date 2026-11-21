import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [git, repository, ...args] = process.argv.slice(2);
const remote = 'https://github.com/contour/dispatch.git';
const index = args.indexOf(remote);
const env = { ...process.env };
if (index >= 0) {
  if (!args.includes('clone') && !args.includes('fetch')) throw new Error('Expected a snapshot clone or fetch.');
  args[index] = pathToFileURL(repository).href;
  args.unshift('-c', 'protocol.file.allow=always');
  env.GIT_ALLOW_PROTOCOL = 'file';
}
const result = spawnSync(git, args, { stdio: 'inherit', env });
if (result.error) throw result.error;
if (result.status === null) throw new Error('Fixture git stopped with signal ' + result.signal);
process.exitCode = result.status;
