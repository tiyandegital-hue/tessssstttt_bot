/**
 * ACP session client (Milestone 1).
 *
 * Flow (from the spec):
 *   start child → `initialize` call → `initialized` notification →
 *   `session/new` → `session/prompt` (streamed `session/update`s) →
 *   `session/cancel` to stop a turn → orderly shutdown.
 *
 * Auth classification: a provider that answers `initialize`/`session/new`
 * with an auth-shaped error (or exits at once with a sign-in line on
 * stderr) is reported as not-signed-in — never as a fake reply.
 */

import { NdjsonTransport } from './jsonrpc.js';
import {
  textFromSessionUpdate,
  type InitializeResult,
  type NewSessionResult,
  type PromptResult,
  type SessionUpdate,
} from './types.js';
import { ProviderError, notSignedIn } from '../errors.js';

export interface AcpClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Client name presented in `initialize`. Default: 'tessssstttt-bot'. */
  clientName?: string;
  clientVersion?: string;
  /** Protocol version we speak. ACP servers accept a number; default 1. */
  protocolVersion?: number;
  /** Timeout for `initialize`. Default 180_000 (long start, per spec). */
  initializeTimeoutMs?: number;
  /** Timeout for `session/new`. Default 30_000. */
  newSessionTimeoutMs?: number;
  /** Max silence inside a turn before it is ended as stalled. Default 300_000 (5 min). */
  turnStallMs?: number;
  maxLineBytes?: number;
}

const AUTH_HINTS = [
  'auth',
  'sign in',
  'sign-in',
  'signed in',
  'login',
  'log in',
  'unauthenticated',
  'unauthorized',
  '401',
  'not logged in',
  'authentication',
];

function looksLikeAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTH_HINTS.some((h) => lower.includes(h));
}

export class AcpClient {
  private readonly transport: NdjsonTransport;
  private readonly opts: Required<
    Pick<
      AcpClientOptions,
      'clientName' | 'clientVersion' | 'protocolVersion' | 'initializeTimeoutMs' | 'newSessionTimeoutMs' | 'turnStallMs'
    >
  >;
  private initialized = false;
  private updateHandlers = new Set<(u: SessionUpdate) => void>();
  private readonly providerLabel: string;

  constructor(opts: AcpClientOptions, providerLabel = 'provider') {
    this.opts = {
      clientName: opts.clientName ?? 'tessssstttt-bot',
      clientVersion: opts.clientVersion ?? '0.1.0',
      protocolVersion: opts.protocolVersion ?? 1,
      initializeTimeoutMs: opts.initializeTimeoutMs ?? 180_000,
      newSessionTimeoutMs: opts.newSessionTimeoutMs ?? 30_000,
      turnStallMs: opts.turnStallMs ?? 300_000,
    };
    this.providerLabel = providerLabel;
    this.transport = new NdjsonTransport({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      maxLineBytes: opts.maxLineBytes,
    });
    this.transport.onNotification((method, params) => {
      if (method !== 'session/update') return;
      const text = textFromSessionUpdate(params);
      const update: SessionUpdate = { raw: params, text };
      for (const h of this.updateHandlers) {
        try {
          h(update);
        } catch {
          // Handler failure must not kill the session.
        }
      }
    });
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  onUpdate(handler: (u: SessionUpdate) => void): () => void {
    this.updateHandlers.add(handler);
    return () => this.updateHandlers.delete(handler);
  }

  /** Start the child and run the `initialize` handshake. */
  async initialize(): Promise<InitializeResult> {
    this.transport.start();
    let result: unknown;
    try {
      result = await this.transport.request(
        'initialize',
        {
          protocolVersion: this.opts.protocolVersion,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          clientInfo: { name: this.opts.clientName, version: this.opts.clientVersion },
        },
        this.opts.initializeTimeoutMs,
      );
    } catch (err) {
      throw this.classify(err, 'initialize');
    }
    this.transport.notify('initialized', {});
    this.initialized = true;
    return (result ?? {}) as InitializeResult;
  }

  /** Open a new session. Returns the provider's session id. */
  async newSession(cwd?: string, mcpServers?: unknown[]): Promise<NewSessionResult> {
    const params: Record<string, unknown> = {};
    if (cwd) params.cwd = cwd;
    if (mcpServers) params.mcpServers = mcpServers;
    let result: unknown;
    try {
      result = await this.transport.request('session/new', params, this.opts.newSessionTimeoutMs);
    } catch (err) {
      throw this.classify(err, 'session/new');
    }
    const r = (result ?? {}) as NewSessionResult;
    if (typeof r.sessionId !== 'string' || r.sessionId.length === 0) {
      throw new ProviderError(
        'protocol',
        'Provider opened a session without an id.',
        'Restart the provider. If it keeps happening, the provider version may be incompatible.',
      );
    }
    return r;
  }

  /**
   * Send one prompt and stream updates until the turn ends.
   * Resolves with the full text plus the provider's stop reason.
   * If the turn stalls (no update for `turnStallMs`), the turn is cancelled
   * and a timeout error is thrown — the partial text is attached, never
   * presented as a finished reply.
   */
  async prompt(
    sessionId: string,
    text: string,
    onUpdate?: (u: SessionUpdate) => void,
  ): Promise<{ text: string; stopReason?: string; partial: boolean }> {
    let collected = '';
    let lastUpdateAt = Date.now();
    let settled = false;
    const offUser = onUpdate ? this.onUpdate(onUpdate) : undefined;
    const offSelf = this.onUpdate((u) => {
      collected += u.text;
      lastUpdateAt = Date.now();
    });
    const cleanup = () => {
      offUser?.();
      offSelf();
    };
    return new Promise<{ text: string; stopReason?: string; partial: boolean }>((resolve, reject) => {
      const stallTimer = setInterval(() => {
        if (settled) return;
        if (Date.now() - lastUpdateAt > this.opts.turnStallMs) {
          settled = true;
          clearInterval(stallTimer);
          cleanup();
          void this.cancel(sessionId).catch(() => undefined);
          const err = new ProviderError(
            'timeout',
            `Provider stopped sending updates for ${this.opts.turnStallMs} ms during a turn.`,
            'The provider may be stuck. Try again, or restart the provider.',
          );
          (err as unknown as { partialText?: string }).partialText = collected;
          reject(err);
        }
      }, 250);
      stallTimer.unref?.();
      void this.transport
        .request(
          'session/prompt',
          { sessionId, prompt: [{ type: 'text', text }] },
          // The stall watchdog ends stuck turns; this is only a ceiling.
          this.opts.turnStallMs * 3 + 60_000,
        )
        .then((result) => {
          if (settled) return;
          settled = true;
          clearInterval(stallTimer);
          cleanup();
          resolve({ text: collected, stopReason: (result as PromptResult)?.stopReason, partial: false });
        })
        .catch((err: unknown) => {
          if (settled) return;
          settled = true;
          clearInterval(stallTimer);
          cleanup();
          reject(this.classify(err, 'session/prompt'));
        });
    });
  }

  /** Cancel a running turn. Never throws for a missing session. */
  async cancel(sessionId: string): Promise<void> {
    try {
      await this.transport.request('session/cancel', { sessionId }, 10_000);
    } catch {
      // Cancel is best-effort; the turn end is reported by the prompt call.
    }
  }

  /** Orderly stop: clear initialized state, close the child. */
  shutdown(reason = 'session closed'): void {
    this.initialized = false;
    this.transport.shutdown(reason);
  }

  /** Map a raw failure to an honest ProviderError.
   *
   * Only protocol-level auth errors (a live process answering with an
   * auth-shaped error) classify as not-signed-in. A process that EXITED
   * stays 'exited' — its stderr line is attached as detail for the user
   * to read, but an exit is a process failure, not a sign-in state.
   * (Spec: an early exit "becomes an error naming how the process ended".)
   */
  private classify(err: unknown, method: string): unknown {
    if (err instanceof ProviderError) {
      return err;
    }
    if (err instanceof Error) {
      if (looksLikeAuthError(err.message)) {
        return notSignedIn(
          this.providerLabel,
          'Sign in with the provider first, then press Connect.',
          undefined,
          err.message,
        );
      }
      return new ProviderError(
        'protocol',
        `Provider call "${method}" failed: ${err.message}`,
        'Restart the provider. If it keeps failing, the provider version may be incompatible.',
      );
    }
    return new ProviderError(
      'protocol',
      `Provider call "${method}" failed with an unknown error.`,
      'Restart the provider.',
    );
  }
}
