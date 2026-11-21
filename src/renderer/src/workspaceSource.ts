import type { AddWorkspaceInput, WorkspaceKind } from '../../shared/domain';

const GITHUB_SOURCE = /^(?:https:\/\/github\.com\/)?([A-Z0-9][A-Z0-9-]{0,38})\/([\w.-]+)\/?$/i;
const ABSOLUTE_FOLDER = /^(?:\/|[A-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i;
const MAX_SOURCE_LENGTH = 4096;

export type RepositoryInput = Exclude<AddWorkspaceInput, { kind: 'topic' }>;

function githubInput(source: string): Extract<RepositoryInput, { kind: 'github' }> | undefined {
  const match = GITHUB_SOURCE.exec(source);
  const owner = match?.[1];
  const repo = match?.[2];
  const name = repo?.replace(/\.git$/, '');
  if (!owner || !repo || !name || name === '.' || name === '..' || name.length > 100) return;
  return { kind: 'github', owner, repo };
}

export function repositoryInput(value: string): RepositoryInput | undefined {
  const source = value.trim();
  if (!source || source.length > MAX_SOURCE_LENGTH || /[\r\n]/.test(source) || source.includes('\0')) return;
  if (ABSOLUTE_FOLDER.test(source)) return { kind: 'git', path: source };
  return githubInput(source);
}

export function workspaceInput(kind: WorkspaceKind, value: string): AddWorkspaceInput {
  if (kind === 'topic') {
    const title = value.trim().replace(/\s+/g, ' ');
    if (!title) throw new Error('Name the topic you want to learn.');
    if (title.length > 120) throw new Error('Keep the topic to 120 characters or fewer.');
    return { kind, title };
  }
  const input = repositoryInput(value);
  if (input?.kind === kind) return input;
  if (kind === 'git') throw new Error('Choose a repository folder or enter its absolute path.');
  throw new Error('Use a GitHub repository URL or owner/name, such as https://github.com/example/archon.');
}

export function droppedSource(uriList: string, plainText: string): string {
  const uri = uriList.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#'));
  const text = uri ?? plainText.trim();
  if (!/^file:\/\//i.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== 'file:' || url.search || url.hash) return text;
    const path = decodeURIComponent(url.pathname);
    if (url.hostname) return '\\\\' + url.hostname + path.replaceAll('/', '\\');
    return /^\/[A-Z]:\//i.test(path) ? path.slice(1) : path;
  } catch (error) {
    if (error instanceof TypeError || error instanceof URIError) return text;
    throw error;
  }
}
