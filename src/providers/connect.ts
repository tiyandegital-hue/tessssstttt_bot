/**
 * Provider connect flow (Milestone 1).
 *
 * Behaviour (from the spec):
 * - Row moves to "checking". The installed copy is tested with the version
 *   flag (a user-set override path is the only candidate).
 * - Start the child, send `initialize`, then the `initialized` notice.
 *   Read the account — 5 seconds normally, 120 while the disk restores.
 *   No account means "sign-in-required" and the client stops. A validated
 *   account makes the row "available" (Connected).
 * - Retries back off 500 ms, 1 s, 2 s (maximum 3 attempts). A run of 2
 *   minutes or more clears the failure count; at 3 failures automatic
 *   starting stops and only a user action restarts.
 * - Idle providers stop after 10 minutes (checked every 60 seconds),
 *   unassigned ones after 60 seconds.
 *
 * M1 scope: full flow for `wired` ACP providers. Detection-only providers
 * stop after the version check with an honest "not supported yet" result.
 */

import { AcpClient } from '../acp/client.js';
import { ProviderError, notInstalled, notSignedIn } from '../errors.js';
import type { ProviderDefinition } from './catalog.js';
import { meetsMinimum, resolveBinary, type DetectedBinary } from './detect.js';

export type ProviderStatus =
  | 'unknown'
  | 'not-installed'
  | 'installed'
  | 'checking'
  | 'available'
  | 'sign-in-required'
  | 'error'
  | 'stopped';

export interface ConnectOptions {
  /** Working directory (agent workspace) for the child. */
  cwd?: string;
  /** Account-read timeout, first attempt. Default 5_000 (spec). */
  accountReadMs?: number;
  /** Account-read timeout on retry (disk restore). Default 120_000 (spec). */
  accountReadRetryMs?: number;
  /** Retry delays between attempts. Default [500, 1000, 2000] (spec). */
  retryDelaysMs?: number[];
  /** Max automatic attempts. Default 3 (spec). */
  maxAttempts?: number;
  /** A run this long clears the failure count. Default 120_000 (spec). */
  healthyRunMs?: number;
  /** Idle time after which a provider is stopped. Default 600_000 (spec). */
  idleStopMs?: number;
  /** Idle time for unassigned providers. Default 60_000 (spec). */
  unassignedIdleStopMs?: number;
  /** How often the idle sweeper runs. Default 60_000 (spec). */
  idleCheckMs?: number;
  /** Max silence inside a turn before it is ended as stalled. Default 300_000 (spec: 5 min). */
  turnStallMs?: number;
  /** Extra env for the child (already filtered by the caller). */
  env?: Record<string, string>;
}

export interface ConnectResult {
  status: ProviderStatus;
  /** Live ACP client when connected. Caller owns shutdown. */
  client?: AcpClient;
  sessionId?: string;
  binary?: DetectedBinary;
  /** Honest error when status is not 'available'. */
  error?: ProviderError;
  /** How many attempts it took. */
  attempts: number;
}

/** Default options (spec numbers). Tests override the timers. */
export function defaultConnectOptions(): Required<ConnectOptions> {
  return {
    cwd: process.cwd(),
    accountReadMs: 5_000,
    accountReadRetryMs: 120_000,
    retryDelaysMs: [500, 1000, 2000],
    maxAttempts: 3,
    healthyRunMs: 120_000,
    idleStopMs: 600_000,
    unassignedIdleStopMs: 60_000,
    idleCheckMs: 60_000,
    turnStallMs: 300_000,
    env: {},
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Build the child environment: the app environment plus only that
 * provider's own key/home variables (per spec — never a grab-bag). */
export function buildChildEnv(def: ProviderDefinition, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...extra };
  for (const key of def.envKeys ?? []) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

/**
 * Connect one provider. Returns a result — it never throws for an expected
 * provider state (not installed / not signed in / too old). It only throws
 * for programmer errors.
 */
export async function connectProvider(
  def: ProviderDefinition,
  opts: ConnectOptions = {},
  tracker?: FailureTracker,
): Promise<ConnectResult> {
  const o = { ...defaultConnectOptions(), ...opts };
  const attempts = tracker?.attemptsFor(def.id) ?? 0;
  if (tracker && tracker.isAutoStartStopped(def.id)) {
    return {
      status: 'error',
      attempts,
      error: new ProviderError(
        'busy',
        `${def.label} failed 3 times. Automatic starting is stopped.`,
        'Press Connect on the provider row to try again yourself.',
        { providerId: def.id },
      ),
    };
  }

  // 1. Resolve + version-check the binary.
  let binary: DetectedBinary;
  try {
    binary = await resolveBinary(def);
  } catch (err) {
    tracker?.recordFailure(def.id);
    return {
      status: 'not-installed',
      attempts: attempts + 1,
      error: notInstalled(def.label, def.installHint, def.id),
    };
  }
  if (!meetsMinimum(binary.version, def.minVersion)) {
    tracker?.recordFailure(def.id);
    return {
      status: 'error',
      attempts: attempts + 1,
      error: new ProviderError(
        'not-supported',
        `${def.label} ${binary.version ?? '(unknown version)'} is older than the required ${def.minVersion}.`,
        def.installHint,
        { providerId: def.id },
      ),
    };
  }

  if (def.wiring !== 'wired' || !def.launchArgs) {
    // Detection-only in M1: honest about what is and is not built.
    return {
      status: 'installed',
      binary,
      attempts: attempts + 1,
      error: new ProviderError(
        'not-supported',
        `${def.label} is installed (${binary.version ?? 'unknown version'}) but its live session is not wired in Milestone 1.`,
        'Detection works. The live session for this provider lands in a later milestone.',
        { providerId: def.id },
      ),
    };
  }

  // 2. Start + initialize + read the account, with spec backoff.
  const delays = o.retryDelaysMs;
  let lastError: ProviderError | null = null;
  for (let attempt = 0; attempt < o.maxAttempts; attempt++) {
    if (attempt > 0) await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 1000);
    const client = new AcpClient(
      {
        command: binary.path,
        args: def.launchArgs,
        cwd: o.cwd,
        env: buildChildEnv(def, o.env),
        initializeTimeoutMs: o.accountReadMs,
        newSessionTimeoutMs: o.accountReadMs,
        turnStallMs: o.turnStallMs,
      },
      def.label,
    );
    try {
      await client.initialize();
      // Account read: session/new must succeed. First try the normal
      // window; on timeout, retry once with the disk-restore window.
      let session: { sessionId: string };
      try {
        session = await client.newSession(o.cwd);
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'timeout') {
          client.shutdown('account read timed out, retrying with disk-restore window');
          const retryClient = new AcpClient(
            {
              command: binary.path,
              args: def.launchArgs,
              cwd: o.cwd,
              env: buildChildEnv(def, o.env),
              initializeTimeoutMs: o.accountReadRetryMs,
              newSessionTimeoutMs: o.accountReadRetryMs,
              turnStallMs: o.turnStallMs,
            },
            def.label,
          );
          await retryClient.initialize();
          session = await retryClient.newSession(o.cwd);
          tracker?.recordSuccess(def.id, o.healthyRunMs);
          return { status: 'available', client: retryClient, sessionId: session.sessionId, binary, attempts: attempt + 1 };
        }
        throw err;
      }
      tracker?.recordSuccess(def.id, o.healthyRunMs);
      return { status: 'available', client, sessionId: session.sessionId, binary, attempts: attempt + 1 };
    } catch (err) {
      client.shutdown('connect failed');
      if (err instanceof ProviderError) {
        lastError = err;
        // Sign-in problems are final — retrying cannot fix them.
        if (err.kind === 'not-signed-in') {
          tracker?.recordFailure(def.id);
          return { status: 'sign-in-required', binary, attempts: attempt + 1, error: err };
        }
        if (err.kind === 'exited' || err.kind === 'timeout') {
          // Retryable: fall through to the next attempt.
          continue;
        }
        tracker?.recordFailure(def.id);
        return { status: 'error', binary, attempts: attempt + 1, error: err };
      }
      lastError = new ProviderError(
        'protocol',
        `${def.label} failed to connect: ${err instanceof Error ? err.message : 'unknown error'}`,
        'Restart the provider. If it keeps failing, the provider version may be incompatible.',
        { providerId: def.id },
      );
    }
  }
  tracker?.recordFailure(def.id);
  return {
    status: 'error',
    binary,
    attempts: o.maxAttempts,
    error:
      lastError ??
      new ProviderError('timeout', `${def.label} did not answer in time.`, 'Try again, or restart the provider.', {
        providerId: def.id,
      }),
  };
}

/**
 * Failure accounting (spec): 3 failures stop automatic starting; a healthy
 * run of `healthyRunMs` clears the count.
 */
export class FailureTracker {
  private failures = new Map<string, number>();
  private healthySince = new Map<string, number>();
  private stopped = new Set<string>();

  attemptsFor(_id: string): number {
    return 0; // Attempts are counted per connect call; kept for the interface.
  }

  recordFailure(id: string): void {
    const n = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, n);
    if (n >= 3) this.stopped.add(id);
  }

  recordSuccess(id: string, healthyRunMs: number): void {
    this.healthySince.set(id, Date.now());
    // A run that stays healthy for `healthyRunMs` clears the count.
    setTimeout(() => {
      this.failures.delete(id);
      this.stopped.delete(id);
    }, healthyRunMs).unref?.();
  }

  isAutoStartStopped(id: string): boolean {
    return this.stopped.has(id);
  }

  reset(id: string): void {
    this.failures.delete(id);
    this.stopped.delete(id);
    this.healthySince.delete(id);
  }
}

/** Human words for a status (for the CLI / later UI). */
export function describeStatus(status: ProviderStatus): string {
  switch (status) {
    case 'available':
      return 'Connected';
    case 'sign-in-required':
      return 'Sign-in required';
    case 'not-installed':
      return 'Not installed';
    case 'installed':
      return 'Installed (session not wired in M1)';
    case 'checking':
      return 'Checking…';
    case 'error':
      return 'Error';
    case 'stopped':
      return 'Stopped';
    default:
      return 'Unknown';
  }
}

export { notSignedIn };
