/**
 * Honest error model (Milestone 1).
 *
 * Rule: the app NEVER invents a provider reply. When a provider cannot be
 * reached, is not installed, or is not signed in, the caller gets one of
 * these errors with a human-readable fix. No synthetic agent text is ever
 * produced.
 */

/** Machine-readable reason for a provider failure. */
export type ProviderFailureKind =
  | 'not-installed'
  | 'not-signed-in'
  | 'not-supported'
  | 'timeout'
  | 'exited'
  | 'protocol'
  | 'cancelled'
  | 'busy';

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;
  /** What the user (or agent owner) can do next. Empty when nothing helps. */
  readonly fix: string;
  /** Which provider this came from, when known. */
  readonly providerId?: string;
  /** Last diagnostic line from the provider's stderr, redacted. */
  readonly detail?: string;

  constructor(
    kind: ProviderFailureKind,
    message: string,
    fix: string,
    opts?: { providerId?: string; detail?: string },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.fix = fix;
    this.providerId = opts?.providerId;
    this.detail = opts?.detail;
  }
}

export function notInstalled(providerLabel: string, installHint: string, providerId?: string): ProviderError {
  return new ProviderError(
    'not-installed',
    `${providerLabel} is not installed on this computer.`,
    installHint,
    { providerId },
  );
}

export function notSignedIn(
  providerLabel: string,
  signInHint: string,
  providerId?: string,
  detail?: string,
): ProviderError {
  return new ProviderError(
    'not-signed-in',
    `${providerLabel} is not signed in.`,
    signInHint,
    { providerId, detail },
  );
}
