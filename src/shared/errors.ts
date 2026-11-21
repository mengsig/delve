/** An expected, user-facing failure with a stable code. */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DomainError';
    this.code = code;
  }
}
