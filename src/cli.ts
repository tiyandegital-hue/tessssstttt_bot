#!/usr/bin/env node
/**
 * Milestone 1 command-line interface.
 *
 *   tessssstttt-bot status                  list providers + detection
 *   tessssstttt-bot probe <provider>        run the connect flow once
 *   tessssstttt-bot prompt <provider> <text...>   one prompt, streamed
 *   tessssstttt-bot prompt --command <cmd...> -- <text...>  custom ACP agent
 *
 * Exit codes: 0 ok, 1 provider honest error, 2 usage error.
 * The CLI never prints invented provider text.
 */

import { AcpClient } from './acp/client.js';
import { ProviderError } from './errors.js';
import { PICKER_ONLY_PROVIDERS, PROVIDERS, getProvider } from './providers/catalog.js';
import { connectProvider, describeStatus } from './providers/connect.js';
import { meetsMinimum, resolveBinary } from './providers/detect.js';

const VERSION = '0.1.0';

function usage(): void {
  console.log(`tessssstttt-bot ${VERSION} — Milestone 1 (core + provider connection)
Usage:
  tessssstttt-bot status
  tessssstttt-bot probe <provider>
  tessssstttt-bot prompt <provider> <text...>
  tessssstttt-bot prompt --command <cmd...> -- <text...>
Providers: ${PROVIDERS.map((p) => p.id).join(', ')}`);
}

function printProviderError(err: unknown): void {
  if (err instanceof ProviderError) {
    console.error(`Error [${err.kind}]: ${err.message}`);
    if (err.fix) console.error(`Fix: ${err.fix}`);
    if (err.detail) console.error(`Detail: ${err.detail}`);
    const partial = (err as unknown as { partialText?: string }).partialText;
    if (partial) console.error(`Partial reply (unfinished, not a completed answer): ${partial}`);
  } else if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error('Error: unknown failure');
  }
}

async function cmdStatus(): Promise<number> {
  console.log('Provider'.padEnd(22) + 'Status'.padEnd(30) + 'Version / source');
  console.log('-'.repeat(80));
  for (const def of PROVIDERS) {
    let line: string;
    try {
      const bin = await resolveBinary(def);
      const ok = meetsMinimum(bin.version, def.minVersion);
      const state = ok ? 'installed' : `too old (needs ${def.minVersion})`;
      line =
        def.label.padEnd(22) +
        `${state} (${def.wiring})`.padEnd(30) +
        `${bin.version ?? 'unknown version'} [${bin.source}: ${bin.path}]`;
    } catch {
      line = def.label.padEnd(22) + 'not installed'.padEnd(30) + def.installHint;
    }
    console.log(line);
  }
  console.log('');
  console.log('Picker-only (listed in the spec, adapter not verified):');
  for (const p of PICKER_ONLY_PROVIDERS) console.log(`  ${p.label} — ${p.note}`);
  return 0;
}

async function cmdProbe(id: string): Promise<number> {
  const def = getProvider(id);
  if (!def) {
    console.error(`Unknown provider: ${id}`);
    return 2;
  }
  const result = await connectProvider(def);
  console.log(`${def.label}: ${describeStatus(result.status)} (attempts: ${result.attempts})`);
  if (result.binary) {
    console.log(`  binary: ${result.binary.path} (${result.binary.version ?? 'unknown version'}, ${result.binary.source})`);
  }
  if (result.sessionId) console.log(`  session: ${result.sessionId}`);
  if (result.error) {
    printProviderError(result.error);
    return 1;
  }
  result.client?.shutdown('probe done');
  return 0;
}

async function cmdPrompt(argv: string[]): Promise<number> {
  // Custom ACP agent: prompt --command <cmd...> -- <text...>
  if (argv[0] === '--command') {
    const sep = argv.indexOf('--');
    if (sep < 2) {
      console.error('Usage: prompt --command <cmd...> -- <text...>');
      return 2;
    }
    const command = argv[1] as string;
    const args = argv.slice(2, sep);
    const text = argv.slice(sep + 1).join(' ');
    if (!text) {
      console.error('Usage: prompt --command <cmd...> -- <text...>');
      return 2;
    }
    const client = new AcpClient({ command, args }, 'custom agent');
    try {
      await client.initialize();
      const session = await client.newSession(process.cwd());
      const out = await client.prompt(session.sessionId, text, (u) => {
        if (u.text) process.stdout.write(u.text);
      });
      if (out.text && !out.text.endsWith('\n')) process.stdout.write('\n');
      console.error(`[stop: ${out.stopReason ?? 'unknown'}]`);
      return 0;
    } catch (err) {
      printProviderError(err);
      return 1;
    } finally {
      client.shutdown('prompt done');
    }
  }

  const [id, ...rest] = argv;
  if (!id || rest.length === 0) {
    console.error('Usage: prompt <provider> <text...>');
    return 2;
  }
  const def = getProvider(id);
  if (!def) {
    console.error(`Unknown provider: ${id}`);
    return 2;
  }
  const text = rest.join(' ');
  const result = await connectProvider(def);
  if (!result.client || !result.sessionId) {
    console.log(`${def.label}: ${describeStatus(result.status)}`);
    if (result.error) printProviderError(result.error);
    return 1;
  }
  try {
    const out = await result.client.prompt(result.sessionId, text, (u) => {
      if (u.text) process.stdout.write(u.text);
    });
    if (out.text && !out.text.endsWith('\n')) process.stdout.write('\n');
    console.error(`[stop: ${out.stopReason ?? 'unknown'}]`);
    return 0;
  } catch (err) {
    printProviderError(err);
    return 1;
  } finally {
    result.client.shutdown('prompt done');
  }
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'status':
      return cmdStatus();
    case 'probe':
      if (!rest[0]) {
        console.error('Usage: probe <provider>');
        return 2;
      }
      return cmdProbe(rest[0]);
    case 'prompt':
      return cmdPrompt(rest);
    case 'version':
      console.log(VERSION);
      return 0;
    case undefined:
    case 'help':
    case '--help':
      usage();
      return 0;
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    printProviderError(err);
    process.exit(1);
  });
