/**
 * Minimal Agent Client Protocol (ACP) message shapes used by Milestone 1.
 *
 * ACP is JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout (public
 * Agent Client Protocol). Only the calls Milestone 1 needs are modelled.
 * Unknown fields are tolerated — providers may send more than this.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg);
}

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'id' in msg && 'method' in msg;
}

/** Result of `initialize`. */
export interface InitializeResult {
  protocolVersion?: number | string;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: { name?: string; version?: string; [k: string]: unknown };
  authMethods?: Array<{ id?: string; name?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** Result of `session/new`. */
export interface NewSessionResult {
  sessionId: string;
  modes?: unknown;
  models?: unknown;
  [k: string]: unknown;
}

/** Result of `session/prompt`. */
export interface PromptResult {
  stopReason?: string;
  [k: string]: unknown;
}

/** One streamed update delivered while a prompt runs. */
export interface SessionUpdate {
  /** Raw update object as the provider sent it. */
  raw: unknown;
  /** Text accumulated from this update, if any. */
  text: string;
}

/** Extract readable text from a `session/update` notification, if present.
 * ACP updates carry text in several shapes; we accept the common ones and
 * ignore the rest instead of guessing. */
export function textFromSessionUpdate(params: unknown): string {
  if (params === null || typeof params !== 'object') return '';
  const p = params as Record<string, unknown>;
  const update = p.update as Record<string, unknown> | undefined;
  if (!update || typeof update !== 'object') return '';
  // { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '...' } } }
  const content = update.content as Record<string, unknown> | undefined;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  if (typeof update.text === 'string') return update.text;
  if (typeof update.content === 'string') return update.content;
  return '';
}
