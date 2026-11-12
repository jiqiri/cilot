/**
 * The small part of MCP (Model Context Protocol) this server implements.
 *
 * OpenCode starts a local server as a child process and speaks JSON-RPC 2.0 over stdin and
 * stdout, one JSON document per line. Only the methods a tools-only server has to answer are
 * handled; anything else is refused the way the specification expects, so a client that
 * probes newer capabilities gets a clear "not found" instead of a hang.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

/** A JSON Schema fragment, as `tools/list` has to describe the arguments. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolFile {
  /** A `data:` URI. The bot turns this into an attachment, so the image reaches the chat. */
  uri: string;
  mime: string;
  name?: string;
}

export interface ToolResult {
  /** Human-readable result, which is the tool call's text content. */
  text: string;
  files?: ToolFile[];
  /** Structured data the client may surface as tool metadata. */
  metadata?: Record<string, unknown>;
}

export interface ToolContext {
  /** Aborted when the client sends `notifications/cancelled` for this call. */
  signal: AbortSignal;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

/**
 * Argument readers.
 *
 * Hand-written rather than a schema library: the validators are three tools long, and the
 * messages are the ones an operator reads from Telegram, so they are worth writing out.
 */

export function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`"${key}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

export function readOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`"${key}" must be a string when provided.`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readOptionalPositiveInteger(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`"${key}" must be a positive number when provided.`);
  }
  return parsed;
}

export function readOptionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`"${key}" must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}
