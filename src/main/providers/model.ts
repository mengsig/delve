import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from '@iarna/toml';
import type { TutorRequest, TutorPreview } from '../../shared/reader';
import { validateModel } from './argv';
import { MODEL_OVERRIDE_ENV } from './env';

type ModelSelection = Pick<TutorPreview, 'model' | 'modelSource'>;

function codexConfigModel(): string | null {
  const file = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml');
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
  let config: ReturnType<typeof parse>;
  try {
    config = parse(contents);
  } catch (error) {
    if (error instanceof Error && error.name === 'TomlError') return null;
    throw error;
  }
  const model = config.model;
  return typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(model) ? model : null;
}

export function selectTutorModel(provider: TutorRequest['provider']): ModelSelection {
  if (provider === 'demo') return { model: 'field-tutor-v1', modelSource: 'demo' };
  const override = process.env[MODEL_OVERRIDE_ENV[provider]];
  if (override !== undefined) return { model: validateModel(override), modelSource: 'override' };
  const configured = provider === 'codex' ? codexConfigModel() : null;
  return configured === null ? { model: null, modelSource: 'default' } : { model: configured, modelSource: 'codex-config' };
}
