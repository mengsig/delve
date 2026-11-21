import type { TutorPreview, TutorRequest } from '../../shared/reader';

export function modelLabel(provider: TutorRequest['provider'], selection: Pick<TutorPreview, 'model' | 'modelSource'>): string {
  if (provider === 'demo') return selection.model ?? 'Local tutor';
  if (selection.modelSource === 'codex-config') return `${selection.model} · from Codex config`;
  return selection.model === null ? `${provider === 'codex' ? 'Codex' : 'Claude'} default` : `Requested model: ${selection.model}`;
}
