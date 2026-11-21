import assert from 'node:assert';

const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];

/** The environment a provider CLI sees: the user's, minus variables that would switch it to API billing. */
export function buildChildEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const key of STRIPPED_ENV) delete env[key];
  assert(STRIPPED_ENV.every((k) => !(k in env)), 'API keys must never reach the child');
  assert(Object.keys(env).length <= Object.keys(parent).length, 'the child env only ever loses keys');
  return env;
}
