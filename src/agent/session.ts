/**
 * Agent session (Milestone 1).
 *
 * One agent owns one provider session. The manager:
 * - connects the provider (via the connect flow),
 * - sends one prompt at a time and streams the reply,
 * - cancels a running turn,
 * - shuts sessions down in order, and tracks idle time for the sweeper.
 *
 * Rule: a prompt to a provider that is not connected throws an honest
 * ProviderError. It never returns invented text.
 */

import { AcpClient } from '../acp/client.js';
import type { SessionUpdate } from '../acp/types.js';
import { ProviderError } from '../errors.js';
import { connectProvider, FailureTracker, type ConnectOptions, type ProviderStatus } from '../providers/connect.js';
import { getProvider, type ProviderDefinition } from '../providers/catalog.js';

export interface AgentSessionOptions extends ConnectOptions {
  /** Idle time after which this session is stopped by the sweeper. */
  idleStopMs?: number;
}

export class AgentSession {
  readonly agentId: string;
  readonly providerId: string;
  readonly definition: ProviderDefinition;
  status: ProviderStatus = 'unknown';
  sessionId: string | null = null;
  lastActivityAt = Date.now();
  lastError: ProviderError | null = null;

  private client: AcpClient | null = null;
  private tracker = new FailureTracker();
  private turnRunning = false;

  /**
   * @param definitionOverride — lets tests (and later custom providers)
   * supply a definition instead of the static catalogue. Production code
   * always uses the catalogue.
   */
  constructor(agentId: string, providerId: string, definitionOverride?: ProviderDefinition) {
    const def = definitionOverride ?? getProvider(providerId);
    if (!def) throw new Error(`Unknown provider: ${providerId}`);
    this.agentId = agentId;
    this.providerId = providerId;
    this.definition = def;
  }

  get connected(): boolean {
    return this.status === 'available' && this.client !== null;
  }

  /** Connect (or reconnect) the provider. Manual: resets the failure stop. */
  async connect(opts: AgentSessionOptions = {}): Promise<ProviderStatus> {
    this.tracker.reset(this.providerId);
    this.status = 'checking';
    const result = await connectProvider(this.definition, opts, this.tracker);
    this.status = result.status;
    this.lastError = result.error ?? null;
    if (result.client) {
      this.client = result.client;
      this.sessionId = result.sessionId ?? null;
    }
    this.touch();
    return this.status;
  }

  /**
   * Send one prompt. Returns the streamed reply text.
   * Throws an honest ProviderError when not connected, when the provider
   * is not signed in, or when the turn fails — never a fake reply.
   */
  async prompt(text: string, onUpdate?: (u: SessionUpdate) => void): Promise<string> {
    if (!this.connected || !this.client || !this.sessionId) {
      throw new ProviderError(
        this.status === 'sign-in-required' ? 'not-signed-in' : 'not-installed',
        `Cannot send a message: ${this.definition.label} is ${this.status}.`,
        this.lastError?.fix ?? this.definition.signInHint,
        { providerId: this.providerId },
      );
    }
    if (this.turnRunning) {
      throw new ProviderError(
        'busy',
        'A turn is already running for this agent.',
        'Wait for it to finish, or cancel it first.',
        { providerId: this.providerId },
      );
    }
    this.turnRunning = true;
    this.touch();
    try {
      const out = await this.client.prompt(this.sessionId, text, onUpdate);
      this.touch();
      return out.text;
    } finally {
      this.turnRunning = false;
    }
  }

  /** Cancel the running turn, if any. */
  async cancel(): Promise<void> {
    if (this.client && this.sessionId && this.turnRunning) {
      await this.client.cancel(this.sessionId);
    }
  }

  /** Orderly shutdown: stop the turn, close the provider child. */
  shutdown(reason = 'agent session closed'): void {
    this.status = 'stopped';
    this.sessionId = null;
    const client = this.client;
    this.client = null;
    client?.shutdown(reason);
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  idleMs(now = Date.now()): number {
    return now - this.lastActivityAt;
  }
}

/**
 * Registry of agent sessions with an idle sweeper.
 * Spec: idle providers stop after 10 minutes (checked every 60 seconds),
 * unassigned ones after 60 seconds. M1 wires the sweeper with configurable
 * timers so tests can use short ones.
 */
export class SessionRegistry {
  private sessions = new Map<string, AgentSession>();
  private timer: NodeJS.Timeout | null = null;

  create(agentId: string, providerId: string, definitionOverride?: ProviderDefinition): AgentSession {
    const s = new AgentSession(agentId, providerId, definitionOverride);
    this.sessions.set(agentId, s);
    return s;
  }

  get(agentId: string): AgentSession | undefined {
    return this.sessions.get(agentId);
  }

  all(): AgentSession[] {
    return [...this.sessions.values()];
  }

  remove(agentId: string): void {
    const s = this.sessions.get(agentId);
    if (s) {
      s.shutdown('agent removed');
      this.sessions.delete(agentId);
    }
  }

  startIdleSweeper(opts: { idleStopMs?: number; checkMs?: number } = {}): void {
    const idleStopMs = opts.idleStopMs ?? 600_000;
    const checkMs = opts.checkMs ?? 60_000;
    this.stopIdleSweeper();
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const s of this.sessions.values()) {
        if (s.connected && s.idleMs(now) > idleStopMs) {
          s.shutdown('idle timeout');
        }
      }
    }, checkMs);
    this.timer.unref?.();
  }

  stopIdleSweeper(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  shutdownAll(reason = 'app shutting down'): void {
    this.stopIdleSweeper();
    for (const s of this.sessions.values()) s.shutdown(reason);
    this.sessions.clear();
  }
}
