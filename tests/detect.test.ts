/**
 * Detection tests — fake binaries in a temp dir, real version math.
 */

import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareVersions,
  extractVersion,
  findOnPath,
  meetsMinimum,
  probeVersion,
  resolveBinary,
} from '../src/providers/detect.js';
import type { ProviderDefinition } from '../src/providers/catalog.js';

const baseDef: ProviderDefinition = {
  id: 'fake',
  label: 'Fake Provider',
  kind: 'acp',
  wiring: 'wired',
  binaries: ['fake-provider-bin'],
  launchArgs: ['acp'],
  minVersion: null,
  installHint: 'Install the fake provider.',
  signInHint: 'Sign in to the fake provider.',
};

async function makeFakeBin(dir: string, name: string, versionOutput: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${versionOutput}"; exit 0; fi\necho "fake bin running: $@"\n`);
  await chmod(file, 0o755);
  return file;
}

test('findOnPath finds an executable in a temp dir', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tbot-detect-'));
  const bin = await makeFakeBin(dir, 'fake-provider-bin', 'fake-provider-bin 1.2.3');
  assert.equal(await findOnPath('fake-provider-bin', dir), bin);
  assert.equal(await findOnPath('no-such-bin', dir), null);
});

test('probeVersion reads the first --version line', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tbot-detect-'));
  const bin = await makeFakeBin(dir, 'fake-provider-bin', 'fake-provider-bin 1.2.3');
  assert.equal(await probeVersion(bin), 'fake-provider-bin 1.2.3');
  assert.equal(await probeVersion(path.join(dir, 'missing')), null);
});

test('version compare / extract / minimum', () => {
  assert.equal(extractVersion('fake-acp 0.0.1'), '0.0.1');
  assert.equal(extractVersion('claude 2.1.322'), '2.1.322');
  assert.equal(extractVersion('no version here'), null);
  assert.equal(compareVersions('1.52.0', '1.52.0'), 0);
  assert.equal(compareVersions('3.0.68', '3.0.67'), 1);
  assert.equal(compareVersions('1.51.9', '1.52.0'), -1);
  assert.equal(meetsMinimum('3.0.68', '3.0.68'), true);
  assert.equal(meetsMinimum('3.0.67', '3.0.68'), false);
  assert.equal(meetsMinimum(null, '3.0.68'), false);
  assert.equal(meetsMinimum(null, null), true);
});

test('override path is the only candidate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tbot-detect-'));
  const bin = await makeFakeBin(dir, 'my-fake', 'my-fake 9.9.9');
  const def: ProviderDefinition = { ...baseDef, overrideEnv: 'TESSSTTTTT_FAKE_OVERRIDE' };
  const env = { ...process.env, TESSSTTTTT_FAKE_OVERRIDE: bin };
  const found = await resolveBinary(def, env);
  assert.equal(found.path, bin);
  assert.equal(found.source, 'override');
  assert.equal(found.version, 'my-fake 9.9.9');
});

test('missing binary throws a not-found error', async () => {
  const def: ProviderDefinition = { ...baseDef, binaries: ['definitely-not-a-real-binary-xyz'] };
  await assert.rejects(resolveBinary(def), /no .* found on PATH/);
});

test('override pointing at a non-executable throws', async () => {
  const def: ProviderDefinition = { ...baseDef, overrideEnv: 'TESSSTTTTT_FAKE_OVERRIDE' };
  const env = { ...process.env, TESSSTTTTT_FAKE_OVERRIDE: '/nonexistent/fake-bin' };
  await assert.rejects(resolveBinary(def, env), /not an executable file/);
});
