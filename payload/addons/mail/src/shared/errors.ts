/**
 * The add-on's failure vocabulary.
 *
 * A tool failure is data, not a transport error: the model has to read the code, decide that
 * retrying is pointless, and tell the user what to change. Every code is stable and starts
 * the message, so neither the model nor a test has to parse prose.
 *
 * Nothing here may include a credential, a message body or a stack trace. Stack traces go to
 * stderr through `log`, which OpenCode captures.
 */

export type AddonErrorCode =
  | "not_granted"
  | "unknown_account"
  | "not_configured"
  | "not_editable"
  | "invalid_config"
  | "missing_secret"
  | "too_large"
  | "upstream_error"
  | "rate_limited";

export class AddonError extends Error {
  constructor(
    readonly code: AddonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AddonError";
  }
}

export function fail(code: AddonErrorCode, message: string): never {
  throw new AddonError(code, message);
}

/** The text a tool returns with `isError: true`. Never a stack trace. */
export function errorText(error: unknown): string {
  if (error instanceof AddonError) {
    return `${error.code}: ${error.message}`;
  }
  // An unexpected failure is still reported as a stable code, with the class of failure
  // rather than its internals.
  const message = error instanceof Error ? error.message : String(error);
  return `upstream_error: ${message}`;
}

export function errorCode(error: unknown): AddonErrorCode {
  return error instanceof AddonError ? error.code : "upstream_error";
}

/** stderr only. The transport owns stdout. */
export function log(message: string): void {
  process.stderr.write(`[addon] ${message}\n`);
}
