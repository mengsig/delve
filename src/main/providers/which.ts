import { access, constants } from 'node:fs/promises';
import path from 'node:path';

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    // access() signals "not executable / missing" by throwing
    return false;
  }
}

function candidateNames(name: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [name];
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0);
  return [name, ...exts.map((e) => name + e.toLowerCase()), ...exts.map((e) => name + e.toUpperCase())];
}

/** Finds an executable on PATH without invoking a shell. */
export async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid executable name: ${name}`);
  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue.split(path.delimiter).filter((d) => d.length > 0 && path.isAbsolute(d));
  for (const dir of dirs) {
    for (const candidate of candidateNames(name, env)) {
      const full = path.join(dir, candidate);
      if (await isExecutable(full)) return full;
    }
  }
  return null;
}
