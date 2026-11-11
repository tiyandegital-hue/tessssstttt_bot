/**
 * Live detection tests — against binaries really on this machine.
 * Environment-dependent by nature: they assert what THIS machine has
 * (Claude Code CLI was installed for testing) and that a missing binary
 * is reported honestly. They never sign in to anything.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { getProvider } from '../src/providers/catalog.js';
import { resolveBinary } from '../src/providers/detect.js';
import { redactLine } from '../src/acp/jsonrpc.js';

test('redaction hides secret-like stderr lines', () => {
  assert.equal(redactLine('ordinary line'), 'ordinary line');
  assert.equal(redactLine('key=sk-abc123'), '[redacted secret-like stderr line]');
  assert.equal(redactLine('Authorization: Bearer xyz'), '[redacted secret-like stderr line]');
});

test('real claude binary is detected on this machine (if installed)', async () => {
  const def = getProvider('claude');
  assert.ok(def);
  try {
    const found = await resolveBinary(def);
    assert.match(found.path, /claude$/);
    assert.match(found.version ?? '', /\d+\.\d+\.\d+/);
    assert.equal(found.source, 'path');
  } catch (err) {
    // Acceptable on a machine without Claude: detection must fail honestly.
    assert.match((err as Error).message, /no claude command found on PATH/);
  }
});

test('a missing provider binary is reported, not invented', async () => {
  const def = getProvider('codex');
  assert.ok(def);
  try {
    const found = await resolveBinary(def);
    assert.match(found.version ?? '', /\d+\.\d+/);
  } catch (err) {
    assert.match((err as Error).message, /no codex command found on PATH/);
  }
});

test('node itself resolves as a binary with a version', async () => {
  const found = await resolveBinary({
    id: 'node-check',
    label: 'Node',
    kind: 'acp',
    wiring: 'detection-only',
    binaries: ['node'],
    launchArgs: null,
    minVersion: null,
    installHint: '',
    signInHint: '',
  });
  assert.match(found.path, /node$/);
  assert.match(found.version ?? '', /^v\d+\.\d+\.\d+/);
});
