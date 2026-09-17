/**
 * Project Brain uses a single error type for everything the user might
 * plausibly have caused or can fix. Every one of these carries a human
 * explanation and, where possible, a concrete next command to run.
 *
 * Unexpected internal failures stay as ordinary Errors so they keep their
 * stack traces and are reported as bugs rather than as user mistakes.
 */
export class BrainError extends Error {
  readonly code: string;
  /** Concrete commands or steps that would resolve this. */
  readonly hints: string[];
  /** Extra detail lines shown under the message. */
  readonly details: string[];

  constructor(
    code: string,
    message: string,
    options: { hints?: string[]; details?: string[]; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'BrainError';
    this.code = code;
    this.hints = options.hints ?? [];
    this.details = options.details ?? [];
  }
}

export function isBrainError(error: unknown): error is BrainError {
  return error instanceof BrainError;
}

/** Narrow a caught value to a Node errno-style error. */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
