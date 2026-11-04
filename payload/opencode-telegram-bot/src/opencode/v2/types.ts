/**
 * Raw payload shapes returned by the OpenCode V2 HTTP API.
 *
 * These mirror the JSON the server actually sends (captured from 2.0.32) rather
 * than the published SDK types, which trail the server. Only the fields the
 * adapter consumes are declared; the real payloads carry more.
 */

export interface V2Tokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface V2ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface V2Location {
  directory: string;
}

export interface V2Session {
  id: string;
  projectID?: string;
  slug?: string;
  version?: string;
  title?: string;
  parentID?: string;
  agent?: string;
  model?: V2ModelRef;
  cost?: number;
  tokens?: V2Tokens;
  location?: V2Location;
  time: { created: number; updated: number };
  revert?: { messageID: string; partID?: string };
}

export interface V2ToolTextContent {
  type: "text";
  text?: string;
}

/**
 * A file a tool returned, for example an image an MCP tool produced.
 *
 * MCP image content reaches OpenCode as a `file` item whose `uri` is a `data:` URI, so the
 * bytes travel with the tool result rather than being re-read from disk.
 */
export interface V2ToolFileContent {
  type: "file";
  uri?: string;
  mime?: string;
  name?: string;
}

export interface V2ToolState {
  status: string;
  input?: Record<string, unknown>;
  content?: Array<V2ToolTextContent | V2ToolFileContent>;
  metadata?: Record<string, unknown>;
  error?: { type?: string; message?: string } | string;
}

export interface V2TextContent {
  type: "text";
  text: string;
  time?: { created: number; completed?: number };
}

export interface V2ReasoningContent {
  type: "reasoning";
  text: string;
  time?: { created: number; completed?: number };
}

export interface V2ToolContent {
  type: "tool";
  id: string;
  name: string;
  executed?: boolean;
  state: V2ToolState;
  time?: { created: number; ran?: number; completed?: number };
}

export interface V2FileContent {
  type: "file";
  filename?: string;
  mime?: string;
  source?: unknown;
}

export type V2MessageContent = V2TextContent | V2ReasoningContent | V2ToolContent | V2FileContent;

export interface V2UserMessage {
  type: "user";
  id: string;
  time: { created: number };
  text?: string;
  files?: unknown[];
}

export interface V2AssistantMessage {
  type: "assistant";
  id: string;
  time: { created: number; streamed?: number; completed?: number };
  agent?: string;
  model?: V2ModelRef;
  content?: V2MessageContent[];
  finish?: string;
  cost?: number;
  tokens?: V2Tokens;
  error?: { type?: string; message?: string };
}

export interface V2IdleMessage {
  type: "idle";
  id: string;
  time?: { created: number };
  outcome?: string;
  error?: { type?: string; message?: string };
}

export type V2Message = V2UserMessage | V2AssistantMessage | V2IdleMessage;

export interface V2Event {
  id?: string;
  created?: number;
  type: string;
  location?: V2Location;
  data?: Record<string, unknown>;
}

export interface V2Provider {
  id: string;
  name?: string;
  package?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface V2Model {
  id: string;
  modelID: string;
  providerID: string;
  name?: string;
  package?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  capabilities?: {
    tools?: boolean;
    input?: string[];
    output?: string[];
    temperature?: boolean;
  };
  variants?: Array<{ id: string; settings?: Record<string, unknown> }>;
  time?: { released?: number };
  cost?: Array<{ input?: number; output?: number; cache?: { read?: number; write?: number } }>;
  status?: string;
  enabled?: boolean;
  limit?: { context?: number; output?: number };
}

export interface V2Agent {
  id: string;
  name?: string;
  description?: string;
  mode?: string;
  hidden?: boolean;
  permissions?: Array<{ action: string; resource: string; effect: string }>;
}

export interface V2Command {
  name: string;
  description?: string;
}

export interface V2Skill {
  id: string;
  name?: string;
  description?: string;
}

export interface V2Project {
  id: string;
  canonical: string;
  time: { created: number; updated: number };
}

export interface V2McpServer {
  name: string;
  status?: { status?: string; error?: string };
}

export interface V2PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources?: string[];
  save?: string[];
  source?: { type?: string; messageID?: string; id?: string };
}

export interface V2FormField {
  key: string;
  title?: string;
  description?: string;
  type?: string;
  options?: Array<{ value?: string; label?: string; description?: string }>;
  custom?: boolean;
  multiple?: boolean;
}

export interface V2Form {
  id: string;
  sessionID: string;
  title?: string;
  metadata?: {
    kind?: string;
    tool?: { messageID?: string; id?: string };
  };
  fields?: V2FormField[];
}

export interface V2FileDiff {
  file: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: string;
}

/** Wrapper used by most V2 responses; `/api/project` answers with a bare array. */
export interface V2Envelope<T> {
  location?: V2Location;
  data: T;
}
