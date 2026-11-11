/**
 * Provider detection (Milestone 1).
 *
 * Behaviour (from the spec):
 * - A user-set override path is the only candidate; otherwise the managed
 *   copy wins unless the installed copy is as new. (M1 has no managed
 *   downloads yet, so the installed copy is the only candidate — the
 *   override rule is implemented now, managed downloads land in M2.)
 * - The installed copy is tested with the version flag. Version probe:
 *   10 seconds.
 * - Windows: no login shell, so no PATH override. Elsewhere the login-shell
 *   PATH is merged (cached 60 seconds).
 */

import { execFile, spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderDefinition } from './catalog.js';

export interface DetectedBinary {
  /** Absolute path of the executable. */
  path: string;
  /** First line of `--version` output, when it answered. */
  version: string | null;
  /** Where it came from: explicit override, or PATH. */
  source: 'override' | 'path';
}

export const VERSION_PROBE_TIMEOUT_MS = 10_000;

let cachedShellPath: { at: number; value: string } | null = null;

/** Login-shell PATH, merged with the process PATH. Cached 60 seconds. */
export async function loginShellPath(): Promise<string> {
  if (process.platform === 'win32') return process.env.PATH ?? '';
  const now = Date.now();
  if (cachedShellPath && now - cachedShellPath.at < 60_000) return cachedShellPath.value;
  const shell = process.env.SHELL ?? '/bin/sh';
  const merged = await new Promise<string>((resolve) => {
    execFile(shell, ['-lc', 'printf %s "$PATH"'], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) resolve(process.env.PATH ?? '');
      else resolve(stdout);
    });
  });
  cachedShellPath = { at: now, value: merged };
  return merged;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find `name` on the given PATH string. Returns the first executable hit. */
export async function findOnPath(name: string, pathValue: string): Promise<string | null> {
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = pathValue.split(sep).filter(Boolean);
  const candidates = process.platform === 'win32' ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of dirs) {
    for (const cand of candidates) {
      const full = path.join(dir, cand);
      if (await isExecutable(full)) return full;
    }
  }
  return null;
}

/**
 * Resolve a provider's binary.
 * - If the provider's override env var names an executable, it is the ONLY
 *   candidate (per spec). A missing/non-executable override is an error.
 * - Otherwise the first binary found on the (login-shell merged) PATH wins.
 */
export async function resolveBinary(
  def: ProviderDefinition,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DetectedBinary> {
  const overrideVar = def.overrideEnv;
  if (overrideVar) {
    const override = env[overrideVar];
    if (override && override.trim().length > 0) {
      const p = override.trim();
      if (await isExecutable(p)) {
        const version = await probeVersion(p);
        return { path: p, version, source: 'override' };
      }
      throw new Error(
        `${def.label}: override ${overrideVar} points at "${p}", which is not an executable file.`,
      );
    }
  }
  const searchPath = await loginShellPath();
  for (const name of def.binaries) {
    const found = await findOnPath(name, searchPath);
    if (found) {
      const version = await probeVersion(found);
      return { path: found, version, source: 'path' };
    }
  }
  throw new Error(`${def.label}: no ${def.binaries.join(' or ')} command found on PATH.`);
}

/** Run `<binary> --version` with a 10-second timeout. Null when it does not answer. */
export function probeVersion(binaryPath: string, timeoutMs = VERSION_PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const child = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const first = out.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? null;
      finish(first);
    });
  });
}

/** Compare dotted versions. Returns -1 / 0 / 1. Non-numeric parts compare as strings. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const xa = pa[i] ?? '0';
    const xb = pb[i] ?? '0';
    const na = Number(xa);
    const nb = Number(xb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

/** Pull the first `N(.N)*` version out of `--version` output. */
export function extractVersion(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(/(\d+(?:\.\d+){1,3})/);
  return m?.[1] ?? null;
}

/** True when the detected version meets the spec's minimum (null minimum = any). */
export function meetsMinimum(detected: string | null, minimum: string | null): boolean {
  if (minimum === null) return true;
  const v = extractVersion(detected);
  if (v === null) return false;
  return compareVersions(v, minimum) >= 0;
}
