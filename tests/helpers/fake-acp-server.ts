/**
 * Fake ACP server (TEST DOUBLE ONLY).
 *
 * A tiny process that speaks newline-delimited JSON-RPC like an ACP agent,
 * so the client can be tested without any real provider installed. It is
 * not a provider, never pretends to be one, and is used only by tests.
 *
 * Modes (env FAKEMODE):
 *   ok         — initialize / session/new / session/prompt all succeed.
 *   auth       — session/new fails with an auth-shaped error.
 *   auth-init  — initialize itself fails with an auth-shaped error.
 *   slow       — answers initialize + session/new, never answers prompt.
 *   exit-early — prints a sign-in line on stderr and exits(1) after initialize.
 *   exit-now   — prints a sign-in line on stderr and exits(1) at startup.
 *   longline   — answers initialize/new, then sends one >1 MiB line.
 *
 * `--version` prints "fake-acp 0.0.1" and exits (for version-probe tests).
 */

import * as readline from 'node:readline';

if (process.argv.includes('--version')) {
  console.log('fake-acp 0.0.1');
  process.exit(0);
}

const mode = process.env.FAKEMODE ?? 'ok';
const delayMs = Number(process.env.FAKEDELAY ?? '0');

if (mode === 'exit-now') {
  console.error('fake acp: not signed in — run login first');
  process.exit(1);
}

function send(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function result(id: number | string, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function error(id: number | string, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function chunk(sessionId: string, text: string): void {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return;
  }
  if (!msg.method || msg.id === undefined) return;
  const id = msg.id;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (msg.method) {
    case 'initialize': {
      if (mode === 'auth-init') {
        error(id, -32000, 'authRequired: sign in required');
        return;
      }
      result(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'fake-acp', version: '0.0.1' },
      });
      if (mode === 'exit-early') {
        setTimeout(() => {
          console.error('fake acp: not signed in — run login first');
          process.exit(1);
        }, 50);
      }
      return;
    }
    case 'session/new': {
      if (mode === 'auth') {
        error(id, -32000, 'authRequired: sign in required');
        return;
      }
      result(id, { sessionId: 'fake-session-1' });
      return;
    }
    case 'session/prompt': {
      if (mode === 'slow') return; // Never answer: exercises the stall watchdog.
      if (mode === 'longline') {
        const big = 'x'.repeat(2 * 1024 * 1024);
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: big } } } })}\n`);
        return;
      }
      setTimeout(() => {
        chunk(String(params.sessionId ?? ''), 'Hello ');
        chunk(String(params.sessionId ?? ''), 'from ');
        chunk(String(params.sessionId ?? ''), 'fake ACP.');
        result(id, { stopReason: 'end_turn' });
      }, delayMs);
      return;
    }
    case 'session/cancel': {
      result(id, {});
      return;
    }
    case 'session/load': {
      result(id, { sessionId: params.sessionId ?? 'fake-session-1' });
      return;
    }
    case 'authenticate': {
      result(id, {});
      return;
    }
    default: {
      error(id, -32601, 'Method not found');
    }
  }
});
