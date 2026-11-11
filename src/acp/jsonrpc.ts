/**
 * NDJSON transport for one provider child process (Milestone 1).
 *
 * Behaviour (from the spec):
 * - Newline-delimited JSON over stdin/stdout.
 * - Stdout is piped through a line-length limiter; at the limit the
 *   connection closes and the process ends.
 * - Stderr goes to a redacted diagnostic stream; the last line becomes the
 *   exit detail, read at pipe close, not process exit.
 * - Early exit: a request failing on a closed connection waits up to 2
 *   seconds for the exit report, then becomes an error naming how the
 *   process ended. Pending requests are rejected.
 *
 * Redaction: lines that look like bearer tokens / api keys are replaced
 * before they are stored or surfaced.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ProviderError } from '../errors.js';

export interface TransportOptions {
  /** Command + args to spawn. */
  command: string;
  args: string[];
  /** Working directory of the child. Defaults to the agent workspace. */
  cwd?: string;
  /** Extra environment for the child. */
  env?: Record<string, string>;
  /** Max bytes of one stdout line before the connection is closed. Default 1 MiB. */
  maxLineBytes?: number;
  /** How long a request failing on a closed connection waits for the exit report. Default 2000 ms. */
  earlyExitWaitMs?: number;
}

export interface ExitReport {
  code: number | null;
  signal: string | null;
  /** Last stderr line, redacted. */
  lastStderrLine: string;
}

const SECRET_HINT = /(api[_-]?key|bearer|token|secret|password|sk-[A-Za-z0-9])/i;

export function redactLine(line: string): string {
  if (!SECRET_HINT.test(line)) return line;
  return '[redacted secret-like stderr line]';
}

export class NdjsonTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private stdoutBuffer = '';
  private stderrLines: string[] = [];
  private closed = false;
  private exitReportPromise: Promise<ExitReport> | null = null;
  private notificationHandlers = new Set<(method: string, params: unknown) => void>();
  private readonly maxLineBytes: number;
  private readonly earlyExitWaitMs: number;

  constructor(private readonly opts: TransportOptions) {
    this.maxLineBytes = opts.maxLineBytes ?? 1024 * 1024;
    this.earlyExitWaitMs = opts.earlyExitWaitMs ?? 2000;
  }

  get running(): boolean {
    return this.child !== null && !this.closed;
  }

  /** Last stderr line (redacted), for exit details. */
  get lastStderrLine(): string {
    return this.stderrLines[this.stderrLines.length - 1] ?? '';
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  start(): void {
    if (this.child) return;
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.closed = false;

    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail += chunk;
      const parts = stderrTail.split('\n');
      stderrTail = parts.pop() ?? '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stderrLines.push(redactLine(trimmed));
        if (this.stderrLines.length > 50) this.stderrLines.shift();
      }
    });
    child.stderr.on('end', () => {
      const trimmed = stderrTail.trim();
      if (trimmed) this.stderrLines.push(redactLine(trimmed));
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    const onExit = (code: number | null, signal: string | null) => {
      this.closed = true;
      const report: ExitReport = {
        code,
        signal,
        lastStderrLine: this.lastStderrLine,
      };
      if (this.exitReportPromise) {
        // Resolve the shared promise via the stored resolver below.
        this.resolveExitReport?.(report);
      }
      const err = new ProviderError(
        'exited',
        `Provider process ended (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}).`,
        'Restart the provider from the provider row. If it keeps exiting, read the diagnostic line it printed.',
        { detail: report.lastStderrLine || undefined },
      );
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    };
    child.on('exit', onExit);
    child.on('error', (err: Error) => {
      this.closed = true;
      const wrapped = new ProviderError(
        'exited',
        `Could not start provider process (${this.opts.command}): ${err.message}`,
        'Check that the provider command is installed and runnable.',
      );
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(wrapped);
      }
      this.pending.clear();
    });
  }

  private resolveExitReport: ((r: ExitReport) => void) | null = null;

  /** Wait for the exit report (used by the early-exit path). */
  waitForExit(timeoutMs: number): Promise<ExitReport | null> {
    if (!this.child) return Promise.resolve(null);
    if (this.closed) {
      return Promise.resolve({
        code: this.child.exitCode,
        signal: this.child.signalCode,
        lastStderrLine: this.lastStderrLine,
      });
    }
    if (!this.exitReportPromise) {
      this.exitReportPromise = new Promise<ExitReport>((resolve) => {
        this.resolveExitReport = resolve;
      });
    }
    return Promise.race([
      this.exitReportPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let idx = this.stdoutBuffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.stdoutBuffer.slice(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        // Line-length limit: close the connection and end the process.
        this.shutdown('line-length limit exceeded');
        return;
      }
      if (line.trim().length > 0) this.handleLine(line);
      idx = this.stdoutBuffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxLineBytes) {
      this.shutdown('line-length limit exceeded');
    }
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not JSON: ignore a malformed line rather than crashing the session.
      return;
    }
    if (msg === null || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    if ('id' in m && ('result' in m || 'error' in m)) {
      const pending = this.pending.get(m.id as number | string);
      if (!pending) return;
      this.pending.delete(m.id as number | string);
      clearTimeout(pending.timer);
      if ('error' in m && m.error) {
        const e = m.error as { code?: number; message?: string };
        pending.reject(new Error(`Provider error ${e.code ?? ''}: ${e.message ?? 'unknown error'}`));
      } else {
        pending.resolve(m.result ?? null);
      }
      return;
    }
    if ('method' in m && typeof m.method === 'string') {
      if ('id' in m) {
        // A request from the provider we do not serve: answer method-not-found
        // so the child does not hang waiting.
        this.sendRaw({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32601, message: 'Method not found' },
        });
        return;
      }
      for (const h of this.notificationHandlers) {
        try {
          h(m.method, m.params);
        } catch {
          // A handler failure must not kill the transport.
        }
      }
    }
  }

  private sendRaw(obj: unknown): void {
    if (!this.child || this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // Write after close: the pending-request path reports the exit.
    }
  }

  /**
   * Send a JSON-RPC request and wait for its response.
   * On a closed connection, waits up to `earlyExitWaitMs` for the exit
   * report, then rejects with an error naming how the process ended.
   */
  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.closed) {
      const report = await this.waitForExit(this.earlyExitWaitMs);
      const detail = report?.lastStderrLine;
      throw new ProviderError(
        'exited',
        `Cannot send "${method}": the provider process is not running` +
          (report ? ` (ended with code ${report.code ?? 'null'}${report.signal ? `, signal ${report.signal}` : ''})` : '') +
          '.',
        'Restart the provider from the provider row.',
        { detail: detail || undefined },
      );
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProviderError(
            'timeout',
            `Provider did not answer "${method}" within ${timeoutMs} ms.`,
            'The provider may be busy or stuck. Try again, or restart the provider.',
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendRaw({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params: unknown): void {
    this.sendRaw({ jsonrpc: '2.0', method, params });
  }

  /**
   * Orderly stop: close stdin, then end the whole process tree.
   * (Spec: mark stopping, run cleanup, close stdin, end the tree.)
   */
  shutdown(_reason: string): void {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.closed = true;
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    // Give it a brief moment to exit on stdin close, then force-kill.
    setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, 1000).unref?.();
    const err = new ProviderError(
      'cancelled',
      'Provider connection closed.',
      'Restart the provider from the provider row to use it again.',
    );
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
