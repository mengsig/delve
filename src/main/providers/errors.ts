import { DomainError } from '../../shared/errors';
import type { ProviderId } from '../../shared/domain';

export type ProviderErrorCode =
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_QUOTA'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_CANCELLED'
  | 'PROVIDER_FAILED'
  | 'PROVIDER_INVALID_OUTPUT';

const DISPLAY_NAME: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex' };
const LOGIN_HINT: Record<ProviderId, string> = { claude: '`claude`', codex: '`codex login`' };

export class ProviderError extends DomainError {
  readonly provider: ProviderId;

  constructor(code: ProviderErrorCode, provider: ProviderId, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = 'ProviderError';
    this.provider = provider;
  }

  get retryable(): boolean {
    return this.code === 'PROVIDER_FAILED' || this.code === 'PROVIDER_INVALID_OUTPUT';
  }
}

export function notFoundError(p: ProviderId): ProviderError {
  const bin = p;
  return new ProviderError('PROVIDER_NOT_FOUND', p, `${DISPLAY_NAME[p]} was not found on PATH: install it and make sure \`${bin}\` runs in a terminal`);
}

export function authError(p: ProviderId): ProviderError {
  return new ProviderError('PROVIDER_AUTH', p, `${DISPLAY_NAME[p]} is not signed in: run ${LOGIN_HINT[p]} and log in`);
}

export function apiKeyAuthError(p: ProviderId): ProviderError {
  return new ProviderError(
    'PROVIDER_AUTH',
    p,
    `${DISPLAY_NAME[p]} is not signed in with a subscription: it uses an API key, which bills per use. Delve only runs on a subscription login: run ${LOGIN_HINT[p]} and sign in with your subscription`,
  );
}

export function unknownAuthError(p: ProviderId, detail: string): ProviderError {
  return new ProviderError('PROVIDER_AUTH', p, `Delve could not confirm that ${DISPLAY_NAME[p]} uses a subscription login (${detail}), so it did not run it`);
}

export function quotaError(p: ProviderId): ProviderError {
  return new ProviderError('PROVIDER_QUOTA', p, `Usage limit reached for ${p}; Delve stopped and will not retry`);
}

export function timeoutError(p: ProviderId, ms: number): ProviderError {
  return new ProviderError('PROVIDER_TIMEOUT', p, `${DISPLAY_NAME[p]} did not finish within ${Math.round(ms / 1000)}s and was stopped`);
}

export function cancelledError(p: ProviderId): ProviderError {
  return new ProviderError('PROVIDER_CANCELLED', p, `The ${DISPLAY_NAME[p]} run was cancelled`);
}

export function failedError(p: ProviderId, detail: string, cause?: unknown): ProviderError {
  return new ProviderError('PROVIDER_FAILED', p, `${DISPLAY_NAME[p]} failed: ${detail}`, { cause });
}

export function invalidOutputError(p: ProviderId, detail: string, cause?: unknown): ProviderError {
  return new ProviderError('PROVIDER_INVALID_OUTPUT', p, `${DISPLAY_NAME[p]} returned output Delve could not use: ${detail}`, { cause });
}

const AUTH_PATTERN = /not logged in|please run .*login|invalid api key|authentication/i;
const QUOTA_PATTERN = /usage limit|rate limit|quota|limit reached|\b429\b/i;

/** Returns an auth/quota error when the text says so, otherwise null. */
export function classifyText(p: ProviderId, text: string): ProviderError | null {
  if (AUTH_PATTERN.test(text)) return authError(p);
  if (QUOTA_PATTERN.test(text)) return quotaError(p);
  return null;
}
