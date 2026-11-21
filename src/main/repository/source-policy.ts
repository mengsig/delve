export const MAX_BLOB_BYTES = 128 * 1024;
export const MAX_READ_BYTES = 1024 * 1024;
export const MAX_READ_FILES = 128;
export const MAX_DIFF_FILES = 48;
export const MAX_PATCH_BYTES = 64 * 1024;
export const MAX_DIFF_BYTES = 192 * 1024;

export const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UNSAFE_PATH_TEXT = /[\p{Cc}\p{Cf}\\\uFFFD]/u;
const PRIVATE_NAMES = new Set([
  '.envrc', '.direnv', '.git', '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.npmrc',
  '.pypirc', '.netrc', '.git-credentials', '.vault-token', '.secrets',
]);
const PRIVATE_NAME = /^(?:\.env|\.authinfo|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?|secrets?|tokens?|passwords?|service[-_]account|private[-_]key)(?:[._-].*)?$|\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i;
const PRIVATE_TEXT = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,})\b|https?:\/\/[^/\s:@]+:[^/\s@]+@/;
const BINARY_CONTROL = /(?=\p{Cc})[^\t\n\r]/u;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function isSourcePath(path: string): boolean {
  return path.length > 0 && Buffer.byteLength(path) <= 1024 && !UNSAFE_PATH_TEXT.test(path)
    && path.split('/').every(part =>
      part !== '' && part !== '.' && part !== '..' && !PRIVATE_NAMES.has(part.toLowerCase()) && !PRIVATE_NAME.test(part));
}

export function sourceText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch (cause) {
    if (cause instanceof TypeError && (cause as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return null;
    throw cause;
  }
  return BINARY_CONTROL.test(text) || PRIVATE_TEXT.test(text) ? null : text;
}
