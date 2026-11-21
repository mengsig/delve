import type { AddWorkspaceInput, WorkspaceKind } from '../../shared/domain';

const GITHUB_SOURCE = /^(?:https:\/\/github\.com\/)?([A-Z0-9][A-Z0-9-]{0,38})\/([\w.-]+)\/?$/i;
const ABSOLUTE_FOLDER = /^(?:\/|[A-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i;

export function workspaceInput(kind: WorkspaceKind, value: string): AddWorkspaceInput {
  const source = value.trim();
  if (kind === 'topic') {
    const title = source.replace(/\s+/g, ' ');
    if (!title) throw new Error('Name the topic you want to learn.');
    if (title.length > 120) throw new Error('Keep the topic to 120 characters or fewer.');
    return { kind, title };
  }
  if (kind === 'git') {
    if (!ABSOLUTE_FOLDER.test(source)) throw new Error('Choose a repository folder or enter its absolute path.');
    return { kind, path: source };
  }
  const match = GITHUB_SOURCE.exec(source);
  const owner = match?.[1];
  const repo = match?.[2];
  const name = repo?.replace(/\.git$/, '');
  if (!owner || !repo || !name || name === '.' || name === '..' || name.length > 100) {
    throw new Error('Use a GitHub repository URL or owner/name, such as https://github.com/example/archon.');
  }
  return { kind, owner, repo };
}
