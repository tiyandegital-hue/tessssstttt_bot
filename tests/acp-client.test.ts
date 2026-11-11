/**
 * ACP client tests — against the fake ACP server test double.
 * No real provider is needed for these.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../src/acp/client.js';
import { ProviderError } from '../src/errors.js';

const fakeServer = fileURLToPath(new URL('./helpers/fake-acp-server.js', import.meta.url));

function clientFor(mode: string, extra: Record<string, unknown> = {}): AcpClient {
  return new AcpClient(
    {
      command: process.execPath,
      args: [fakeServer],
      env: { FAKEMODE: mode },
      initializeTimeoutMs: 5000,
      newSessionTimeoutMs: 5000,
      turnStallMs: 800,
      ...(extra as object),
    },
    'Fake ACP',
  );
}

test('initialize handshake + session/new returns a session id', async () => {
  const client = clientFor('ok');
  try {
    const init = await client.initialize();
    assert.equal(init.agentInfo?.name, 'fake-acp');
    assert.equal(client.isInitialized, true);
    const session = await client.newSession(process.cwd());
    assert.equal(session.sessionId, 'fake-session-1');
  } finally {
    client.shutdown('test done');
  }
});

test('prompt streams text chunks and reports the stop reason', async () => {
  const client = clientFor('ok');
  try {
    await client.initialize();
    const session = await client.newSession(process.cwd());
    const seen: string[] = [];
    const out = await client.prompt(session.sessionId, 'hi', (u) => {
      if (u.text) seen.push(u.text);
    });
    assert.equal(out.text, 'Hello from fake ACP.');
    assert.equal(out.stopReason, 'end_turn');
    assert.deepEqual(seen, ['Hello ', 'from ', 'fake ACP.']);
  } finally {
    client.shutdown('test done');
  }
});

test('auth failure on session/new is reported as not-signed-in, never as text', async () => {
  const client = clientFor('auth');
  try {
    await client.initialize();
    await assert.rejects(
      client.newSession(process.cwd()),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal((err as ProviderError).kind, 'not-signed-in');
        assert.match((err as ProviderError).fix, /Sign in/);
        return true;
      },
    );
  } finally {
    client.shutdown('test done');
  }
});

test('auth failure on initialize is reported as not-signed-in', async () => {
  const client = clientFor('auth-init');
  try {
    await assert.rejects(
      client.initialize(),
      (err: unknown) => err instanceof ProviderError && (err as ProviderError).kind === 'not-signed-in',
    );
  } finally {
    client.shutdown('test done');
  }
});

test('a prompt that never answers ends as a stall timeout with partial text, not a fake reply', async () => {
  const client = clientFor('slow');
  try {
    await client.initialize();
    const session = await client.newSession(process.cwd());
    const started = Date.now();
    await assert.rejects(
      client.prompt(session.sessionId, 'hi'),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal((err as ProviderError).kind, 'timeout');
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `stall should fire fast in tests, took ${elapsed} ms`);
    assert.ok(elapsed >= 800, 'stall fired before the stall window');
  } finally {
    client.shutdown('test done');
  }
});

test('early process exit after initialize is reported as exited with the stderr detail', async () => {
  const client = clientFor('exit-early');
  try {
    await client.initialize();
    // The child exits ~50 ms after initialize; the next call must fail honestly.
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(
      client.newSession(process.cwd()),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal((err as ProviderError).kind, 'exited');
        return true;
      },
    );
  } finally {
    client.shutdown('test done');
  }
});

test('an over-long stdout line closes the connection instead of growing memory', async () => {
  const client = clientFor('longline', { maxLineBytes: 1024 });
  try {
    await client.initialize();
    const session = await client.newSession(process.cwd());
    await assert.rejects(
      client.prompt(session.sessionId, 'hi'),
      (err: unknown) => err instanceof ProviderError,
    );
  } finally {
    client.shutdown('test done');
  }
});

test('prompt after shutdown throws an honest exited error', async () => {
  const client = clientFor('ok');
  await client.initialize();
  const session = await client.newSession(process.cwd());
  client.shutdown('test done');
  await assert.rejects(
    client.prompt(session.sessionId, 'hi'),
    (err: unknown) => err instanceof ProviderError && (err as ProviderError).kind === 'exited',
  );
});
