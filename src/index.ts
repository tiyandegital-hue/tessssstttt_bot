/**
 * Public entry point for the Milestone 1 core.
 * The desktop shell (later milestone) imports from here; the CLI is the
 * Milestone 1 interface.
 */

export { AcpClient } from './acp/client.js';
export { NdjsonTransport, redactLine } from './acp/jsonrpc.js';
export type { InitializeResult, NewSessionResult, PromptResult, SessionUpdate } from './acp/types.js';
export { ProviderError, notInstalled, notSignedIn } from './errors.js';
export type { ProviderFailureKind } from './errors.js';
export { PROVIDERS, PICKER_ONLY_PROVIDERS, getProvider } from './providers/catalog.js';
export type { ProviderDefinition, ProviderKind, Wiring } from './providers/catalog.js';
export {
  connectProvider,
  describeStatus,
  FailureTracker,
  buildChildEnv,
  defaultConnectOptions,
} from './providers/connect.js';
export type { ConnectOptions, ConnectResult, ProviderStatus } from './providers/connect.js';
export {
  resolveBinary,
  probeVersion,
  compareVersions,
  extractVersion,
  meetsMinimum,
  loginShellPath,
  VERSION_PROBE_TIMEOUT_MS,
} from './providers/detect.js';
export type { DetectedBinary } from './providers/detect.js';
export { AgentSession, SessionRegistry } from './agent/session.js';
export type { AgentSessionOptions } from './agent/session.js';
