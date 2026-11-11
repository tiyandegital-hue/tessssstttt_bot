# tessssstttt-bot

A clean-room, local-first desktop workspace for persistent AI teammates —
written from a behaviour specification only. No code is copied from any
other desktop application codebase.

> **Status: Milestone 1** — core + provider connection.
> The desktop shell, chat/sessions, agent runtime, teams, integrations,
> auth/billing, mobile/web clients, marketplace, and data layers land in
> later milestones, one at a time, each tested before the next starts.

## What Milestone 1 does

- **Provider catalogue** — Codex, Claude Code, Grok, OpenCode, Gemini
  (Antigravity), Cursor, Cline, Kimi, Devin, GitHub Copilot, Mistral,
  Hermes, plus custom ACP agents. Each entry records only what the
  behaviour spec states. Providers whose launch command the spec does
  not state are listed as **detection-only** — Milestone 1 never invents
  a command line for them.
- **Detection** — override path wins (`OPENBOT_<PROVIDER>_PATH`); otherwise
  the login-shell PATH (cached 60 s). Version probe with a 10-second
  timeout; minimum versions enforced where the spec states them
  (Cline 3.0.68+, Kimi 1.52.0+).
- **ACP over stdio** — newline-delimited JSON-RPC 2.0: `initialize` →
  `initialized` → `session/new` → `session/prompt` (streamed
  `session/update`s) → `session/cancel` → orderly shutdown. Line-length
  limiter on stdout, redacted stderr diagnostics, early-exit handling
  (waits up to 2 s for the exit report).
- **Connect flow** — checking → account read (5 s, 120 s while the disk
  restores) → available / sign-in-required / not-installed / error.
  Retries back off 500 ms → 1 s → 2 s, max 3 attempts; 3 failures stop
  automatic starting until the user presses Connect. Idle providers stop
  after 10 minutes (checked every 60 s).
- **No fake replies, ever.** A prompt to a provider that is not
  installed, not signed in, timed out, or exited throws an honest
  `ProviderError` (kind + fix). The app never invents agent text.

## What Milestone 1 does NOT do yet

- No desktop shell / Electron UI (the CLI is the M1 interface).
- No Codex App Server client, no Claude vendor-SDK sessions, no
  Gemini authenticate flow, no managed provider downloads — detection
  only, honestly reported.
- No chat threads, queues, compaction, teams, marketplace, billing,
  mobile/web clients. Those are later milestones.

## Build & test

```bash
npm install
npm run build    # tsc → dist/
npm test         # build + node --test (real tests, no fakes beyond the
                 # fake ACP server test double in tests/helpers/)
```

## CLI

```bash
node dist/src/cli.js status
node dist/src/cli.js probe cursor
node dist/src/cli.js prompt cursor "hello"
node dist/src/cli.js prompt --command node dist/tests/helpers/fake-acp-server.js -- "hello"
```

## Layout

```
src/
  acp/         NDJSON/JSON-RPC transport + ACP session client
  providers/   catalogue (spec facts only), detection, connect flow
  agent/       agent session + session registry (idle sweeper)
  cli.ts       Milestone 1 command-line interface
  index.ts     public entry point
tests/
  helpers/fake-acp-server.ts   test double speaking ACP over stdio
  acp-client.test.ts  detect.test.ts  connect.test.ts  live-detect.test.ts
```

## Clean-room note

This repository is a clean-room build written from a behaviour
specification. It contains no code copied from any third-party desktop
application codebase. Behaviour facts (provider names, CLI commands,
timeouts, limits) come from the spec and from the providers' own public
documentation.
