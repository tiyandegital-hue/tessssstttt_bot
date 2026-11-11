/**
 * Connect-flow + session tests — the full flow against the fake ACP server,
 * driven through a wrapper script named by an override env var (the only
 * candidate, per spec). No real provider is needed for these.
 */

import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProviderError } from '../src/errors.js';
import type { ProviderDefinition } from '../src/providers/catalog.js';
import { connectProvider, FailureTracker } from '../src/providers/connect.js';
import { AgentSession, SessionRegistry } from '../src/agent/session.js';

const fakeServer = fileURLToPath(new URL('./helpers/fake-acp-server.js', import.meta.url));
const OVERRIDE_ENV = 'TESSSTTTTT_FAKE_BIN';

const fakeDef: ProviderDefinition = {
  id: 'fake',
  label: 'Fake ACP',
  kind: 'acp',
  wiring: 'wired',
  binaries: [],
  launchArgs: [],
  minVersion: null,
  installHint: 'Install the fake provider.',
  signInHint: 'Sign in to the fake provider.',
  overrideEnv: OVERRIDE_ENV,
};

async function makeWrapper(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tbot-connect-'));
  const file = path.join(dir, 'fake-acp');
  await writeFile(file, `#!/bin/sh\nexec node "${fakeServer}" "$@"\n`);
  await chmod(file, 0o755);
  return file;
}

test('connect ok → available with a session id', async () => {
  process.env[OVERRIDE_ENV] = await makeWrapper();
  try {
    const result = await connectProvider(fakeDef, {
      env: { FAKEMODE: 'ok' },
      retryDelaysMs: [10],
      maxAttempts: 1,
    });
    assert.equal(result.status, 'available');
    assert.equal(result.sessionId, 'fake-session-1');
    assert.equal(result.attempts, 1);
    assert.ok(result.client);
    result.client?.shutdown('test done');
  } finally {
    delete process.env[OVERRIDE_ENV];
  }
});

test('connect auth → sign-in-required with a fix, client stopped', async () => {
  process.env[OVERRIDE_ENV] = await makeWrapper();
  try {
    const result = await connectProvider(fakeDef, {
      env: { FAKEMODE: 'auth' },
      retryDelaysMs: [10],
      maxAttempts: 2,
    });
    assert.equal(result.status, 'sign-in-required');
    assert.equal(result.attempts, 1, 'sign-in failure is final, not retried');
    assert.ok(result.error instanceof ProviderError);
    assert.equal((result.error as ProviderError).kind, 'not-signed-in');
    assert.match((result.error as ProviderError).fix, /Sign in/);
    assert.equal(result.client, undefined);
  } finally {
    delete process.env[OVERRIDE_ENV];
  }
});

test('connect missing binary → not-installed with an install hint', async () => {
  delete process.env[OVERRIDE_ENV];
  const def: ProviderDefinition = { ...fakeDef, overrideEnv: undefined, binaries: ['definitely-not-a-real-binary-xyz'] };
  const result = await connectProvider(def, { retryDelaysMs: [10], maxAttempts: 1 });
  assert.equal(result.status, 'not-installed');
  assert.ok(result.error instanceof ProviderError);
  assert.equal((result.error as ProviderError).kind, 'not-installed');
  assert.match((result.error as ProviderError).fix, /Install/);
});

test('three failures stop automatic starting until a manual connect', async () => {
  process.env[OVERRIDE_ENV] = await makeWrapper();
  const tracker = new FailureTracker();
  const opts = { env: { FAKEMODE: 'exit-now' }, retryDelaysMs: [10], maxAttempts: 1, accountReadMs: 3000 };
  try {
    for (let i = 0; i < 3; i++) {
      const r = await connectProvider(fakeDef, opts, tracker);
      assert.equal(r.status, 'error', `attempt ${i + 1} should error`);
    }
    assert.equal(tracker.isAutoStartStopped('fake'), true);
    const stopped = await connectProvider(fakeDef, opts, tracker);
    assert.equal(stopped.status, 'error');
    assert.ok(stopped.error instanceof ProviderError);
    assert.equal((stopped.error as ProviderError).kind, 'busy');
    assert.match((stopped.error as ProviderError).fix, /Press Connect/);
  } finally {
    delete process.env[OVERRIDE_ENV];
  }
});

test('AgentSession prompt works end-to-end through the fake provider', async () => {
  process.env[OVERRIDE_ENV] = await makeWrapper();
  const session = new AgentSession('agent-1', 'fake', fakeDef);
  try {
    const status = await session.connect({
      env: { FAKEMODE: 'ok' },
      retryDelaysMs: [10],
      maxAttempts: 1,
    });
    assert.equal(status, 'available');
    assert.equal(session.connected, true);
    const text = await session.prompt('hello');
    assert.equal(text, 'Hello from fake ACP.');
  } finally {
    session.shutdown('test done');
    delete process.env[OVERRIDE_ENV];
  }
});

test('AgentSession prompt when not connected throws honestly, never fake text', async () => {
  const session = new AgentSession('agent-2', 'cursor');
  await assert.rejects(
    session.prompt('hello'),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.ok(['not-installed', 'not-signed-in'].includes((err as ProviderError).kind));
      return true;
    },
  );
});

test('AgentSession refuses a second concurrent turn', async () => {
  process.env[OVERRIDE_ENV] = await makeWrapper();
  const session = new AgentSession('agent-3', 'fake', fakeDef);
  try {
    await session.connect({
      env: { FAKEMODE: 'slow' },
      retryDelaysMs: [10],
      maxAttempts: 1,
      turnStallMs: 800,
    });
    // Start a turn that never answers (stall window is the 5-minute
    // default, so use a direct client instead for speed — here just assert
    // the guard via a slow first prompt that we cancel quickly).
    const first = session.prompt('hello');
    await assert.rejects(
      session.prompt('second'),
      (err: unknown) => err instanceof ProviderError && (err as ProviderError).kind === 'busy',
    );
    await session.cancel();
    await assert.rejects(first, (err: unknown) => err instanceof ProviderError);
  } finally {
    session.shutdown('test done');
    delete process.env[OVERRIDE_ENV];
  }
});

test('idle sweeper stops a connected session after the idle window', async () => {
  process.env[OVERRIDE_ENV] = await makeWrapper();
  const registry = new SessionRegistry();
  const session = registry.create('agent-idle', 'fake', fakeDef);
  try {
    const status = await session.connect({
      env: { FAKEMODE: 'ok' },
      retryDelaysMs: [10],
      maxAttempts: 1,
    });
    assert.equal(status, 'available');
    registry.startIdleSweeper({ idleStopMs: 100, checkMs: 50 });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(session.status, 'stopped');
  } finally {
    registry.shutdownAll('test done');
    delete process.env[OVERRIDE_ENV];
  }
});
