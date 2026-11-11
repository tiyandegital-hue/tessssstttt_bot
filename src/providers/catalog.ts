/**
 * Provider catalogue (Milestone 1).
 *
 * Every fact here comes from the behaviour spec (Section 1 + Section 3).
 * Where the spec does NOT state a launch command, the provider is listed
 * as detection-only and `launch` is null — M1 never invents a command line.
 * Wiring those providers means verifying the command against the provider's
 * own public docs first (a later milestone).
 */

export type ProviderKind =
  | 'acp' // Speaks ACP over stdio; M1 can connect.
  | 'codex' // Codex App Server over JSON lines; client lands in M2.
  | 'claude-sdk' // No app-owned process; the vendor SDK spawns the CLI.
  | 'antigravity' // Gemini via the Antigravity server; never on PATH.
  | 'custom'; // User-supplied ACP command.

export type Wiring = 'wired' | 'detection-only';

export interface ProviderDefinition {
  id: string;
  label: string;
  kind: ProviderKind;
  wiring: Wiring;
  /** Binary names to look for on PATH, in order. Empty when the spec names none. */
  binaries: string[];
  /** Exact argv to spawn (after the binary), when the spec states it. */
  launchArgs: string[] | null;
  /** Minimum self-installed version, when the spec states one. */
  minVersion: string | null;
  /** How to install / sign in, in the user's words. */
  installHint: string;
  signInHint: string;
  /** Env var naming an explicit executable override, when the spec states one. */
  overrideEnv?: string;
  /** Provider-specific env vars M1 passes through (never invented). */
  envKeys?: string[];
}

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'codex',
    label: 'Codex (ChatGPT)',
    kind: 'codex',
    wiring: 'detection-only',
    binaries: ['codex'],
    launchArgs: ['app-server', '--listen', 'stdio://'],
    minVersion: null,
    installHint: 'Install the Codex CLI, then authenticate it and restart the app.',
    signInHint:
      'Sign in with ChatGPT in the Codex CLI (browser page, 10-minute deadline), or use a device code or API key. Tokens stay in the CLI home folder.',
    envKeys: ['CODEX_HOME'],
  },
  {
    id: 'claude',
    label: 'Claude Code',
    kind: 'claude-sdk',
    wiring: 'detection-only',
    binaries: ['claude'],
    launchArgs: null,
    minVersion: null,
    installHint:
      'Install the Claude Code CLI. On Windows, Git for Windows is also required.',
    signInHint: 'Sign in with the Claude Code CLI, then restart the app.',
  },
  {
    id: 'grok',
    label: 'Grok',
    kind: 'acp',
    wiring: 'detection-only',
    binaries: ['grok'],
    launchArgs: null,
    minVersion: null,
    installHint: 'Install the Grok CLI, then authenticate it.',
    signInHint: 'Run `grok login`, or set XAI_API_KEY in the environment used to launch the app.',
    envKeys: ['XAI_API_KEY'],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    kind: 'acp',
    wiring: 'detection-only',
    binaries: ['opencode'],
    launchArgs: null,
    minVersion: null,
    installHint: 'Install the OpenCode CLI.',
    signInHint:
      'Free models need no sign-in. For paid Go models, paste a Go key; for Zen / third-party models, run the provider login command in a terminal.',
    overrideEnv: 'OPENBOT_OPENCODE_PATH',
    envKeys: ['OPENCODE_API_KEY'],
  },
  {
    id: 'gemini',
    label: 'Gemini (Antigravity)',
    kind: 'antigravity',
    wiring: 'detection-only',
    binaries: [],
    launchArgs: null,
    minVersion: null,
    installHint:
      'Needs a Google AI Pro or Ultra plan. The Antigravity server is downloaded on first Download — it is never taken from PATH.',
    signInHint: 'Sign in opens the Google sign-in page in a browser.',
    overrideEnv: 'OPENBOT_ANTIGRAVITY_PATH',
    envKeys: ['GEMINI_HOME'],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'acp',
    wiring: 'wired',
    binaries: ['cursor-agent'],
    launchArgs: ['acp'],
    minVersion: null,
    installHint: 'Install the Cursor CLI (`cursor-agent`), or use Download in the app.',
    signInHint: 'Sign in opens the Cursor sign-in page in a browser, or set a Cursor API key.',
    overrideEnv: 'OPENBOT_CURSOR_PATH',
    envKeys: ['CURSOR_API_KEY'],
  },
  {
    id: 'cline',
    label: 'Cline',
    kind: 'acp',
    wiring: 'wired',
    binaries: ['cline'],
    launchArgs: ['--acp'],
    minVersion: '3.0.68',
    installHint: 'Install the Cline CLI (3.0.68 or newer), or use Download in the app.',
    signInHint: 'Sign in opens the Cline sign-in page in a browser, or set a Cline API key.',
    overrideEnv: 'OPENBOT_CLINE_PATH',
    envKeys: ['CLINE_API_KEY'],
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    kind: 'acp',
    wiring: 'wired',
    binaries: ['kimi'],
    launchArgs: ['acp'],
    minVersion: '1.52.0',
    installHint: 'Install the Kimi Code CLI (1.52.0 or newer), or use Download in the app.',
    signInHint: 'Sign in runs the provider login command, which opens the Kimi sign-in page.',
    overrideEnv: 'OPENBOT_KIMI_PATH',
  },
  {
    id: 'devin',
    label: 'Devin',
    kind: 'acp',
    wiring: 'detection-only',
    binaries: ['devin'],
    launchArgs: null,
    minVersion: null,
    installHint: 'Install the Devin CLI, or use Download in the app.',
    signInHint: 'Sign in with a Devin account.',
    overrideEnv: 'OPENBOT_DEVIN_PATH',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    kind: 'acp',
    wiring: 'wired',
    binaries: ['copilot'],
    launchArgs: ['--acp', '--no-auto-update'],
    minVersion: null,
    installHint: 'Install the GitHub Copilot CLI, or use Download in the app.',
    signInHint:
      'Sign in opens the GitHub sign-in page. The sign-in is kept in the system keychain.',
    overrideEnv: 'OPENBOT_COPILOT_PATH',
    envKeys: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'acp',
    wiring: 'detection-only',
    binaries: [],
    launchArgs: null,
    minVersion: null,
    installHint: 'Use Download in the app to get the Mistral Vibe protocol server.',
    signInHint: 'Sign in with a Mistral account or a Mistral API key.',
    overrideEnv: 'OPENBOT_MISTRAL_PATH',
    envKeys: ['MISTRAL_API_KEY'],
  },
  {
    id: 'hermes',
    label: 'Hermes',
    kind: 'acp',
    wiring: 'detection-only',
    binaries: ['hermes'],
    launchArgs: null,
    minVersion: null,
    installHint:
      'Install the Hermes Agent yourself. On macOS/Linux, Download runs the official Hermes installer; on Windows it opens the installation guide.',
    signInHint:
      'Sign in runs the provider auth command for a Nous Portal plan, or the setup command in a terminal for other providers.',
  },
];

export function getProvider(id: string): ProviderDefinition | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Extra providers the spec lists only as picker entries (not verified as
 * wired adapters): Mercury/Inception, DeepSeek, OpenRouter. M1 lists them
 * so the gap is visible instead of silently dropped. */
export const PICKER_ONLY_PROVIDERS = [
  { id: 'mercury', label: 'Mercury (Inception)', note: 'Picker listing only; adapter not verified in the spec.' },
  { id: 'deepseek', label: 'DeepSeek', note: 'Picker listing only; adapter not verified in the spec.' },
  { id: 'openrouter', label: 'OpenRouter', note: 'Picker listing only; adapter not verified in the spec.' },
];
