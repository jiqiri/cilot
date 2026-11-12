/**
 * V2 -> V1 shape mappers.
 *
 * The rest of the bot is written against the V1 SDK contract (`{ info, parts }`
 * messages, `provider.models` records, `question.asked` payloads, ...). The V2
 * server returns a different, flatter model, so every response passes through
 * one of these functions before it reaches business logic.
 */
import type {
  V2Agent,
  V2Command,
  V2FileDiff,
  V2Form,
  V2Message,
  V2MessageContent,
  V2Model,
  V2PermissionRequest,
  V2Project,
  V2Provider,
  V2Session,
  V2Skill,
  V2Tokens,
  V2ToolContent,
} from "./types.js";

export interface TokensLike {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface SessionLike {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  parentID?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  cost: number;
  tokens: TokensLike;
  time: { created: number; updated: number };
  revert?: { messageID: string; partID?: string };
}

export interface MessageInfoLike {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  agent?: string;
  providerID?: string;
  modelID?: string;
  variant?: string;
  cost?: number;
  tokens?: TokensLike;
  finish?: string;
  error?: { name: string; data: { message: string } };
}

export interface MessageWithPartsLike {
  info: MessageInfoLike;
  parts: Array<Record<string, unknown>>;
}

export interface ProviderLike {
  id: string;
  name: string;
  source: "env" | "config" | "custom" | "api";
  env: string[];
  options: Record<string, unknown>;
  models: Record<string, Record<string, unknown>>;
}

export interface AgentLike {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
  permission: Array<{ permission: string; pattern: string; action: string }>;
}

export interface CommandLike {
  name: string;
  description?: string;
  source: "command" | "skill";
  template: string;
  hints: string[];
}

export function emptyTokens(): TokensLike {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

function normalizeTokens(tokens: V2Tokens | undefined): TokensLike {
  if (!tokens) {
    return emptyTokens();
  }

  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cache: {
      read: tokens.cache?.read ?? 0,
      write: tokens.cache?.write ?? 0,
    },
  };
}

function defaultTitle(createdAt: number): string {
  return `New session - ${new Date(createdAt).toISOString()}`;
}

export function mapSession(raw: V2Session): SessionLike {
  const createdAt = raw.time?.created ?? Date.now();

  return {
    id: raw.id,
    slug: raw.slug ?? "",
    projectID: raw.projectID ?? "",
    directory: raw.location?.directory ?? "",
    title: raw.title?.trim() ? raw.title : defaultTitle(createdAt),
    version: raw.version ?? "",
    ...(raw.parentID ? { parentID: raw.parentID } : {}),
    ...(raw.agent ? { agent: raw.agent } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    cost: raw.cost ?? 0,
    tokens: normalizeTokens(raw.tokens),
    time: { created: createdAt, updated: raw.time?.updated ?? createdAt },
    ...(raw.revert
      ? { revert: { messageID: raw.revert.messageID, ...(raw.revert.partID ? { partID: raw.revert.partID } : {}) } }
      : {}),
  };
}

/** `session.created` carries a partial session: no title, no timestamps. */
export function mapSessionFromEvent(
  data: Record<string, unknown>,
  createdAt: number,
): SessionLike {
  const location = data.location as { directory?: string } | undefined;
  const model = data.model as { id?: string; providerID?: string; variant?: string } | undefined;
  const raw: V2Session = {
    id: String(data.sessionID ?? ""),
    projectID: typeof data.projectID === "string" ? data.projectID : "",
    slug: typeof data.slug === "string" ? data.slug : "",
    version: typeof data.version === "string" ? data.version : "",
    location: { directory: location?.directory ?? "" },
    ...(typeof data.agent === "string" ? { agent: data.agent } : {}),
    ...(model?.id && model.providerID
      ? { model: { id: model.id, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) } }
      : {}),
    ...(typeof data.parentID === "string" ? { parentID: data.parentID } : {}),
    time: { created: createdAt, updated: createdAt },
  };

  return { ...mapSession(raw), title: defaultTitle(createdAt) };
}

function fileText(part: V2MessageContent): string | null {
  if (part.type === "file") {
    return part.filename ?? null;
  }

  return null;
}

/**
 * Tools the bot still knows by their V1 names.
 *
 * V1 loaded these from a `tools/` directory, so they arrived bare. V2 has no such hook and
 * they now come from a local MCP server named `telegram`, which OpenCode exposes as
 * `<server>_<tool>`. The bot keys behaviour off the name - an image is forwarded to Telegram
 * only for `image_generate` - so the adapter restores the V1 name instead of teaching every
 * consumer about the server prefix.
 *
 * The mapping is an explicit list rather than "strip the first segment": OpenCode ships its
 * own `experimental_image_generate`, and a generic rule would quietly relabel it as ours.
 * Renaming the MCP server in the V2 config means updating this table with it.
 */
const V1_TOOL_NAMES: Record<string, string> = {
  telegram_image_generate: "image_generate",
  telegram_postiz_check_post: "postiz_check_post",
  telegram_postiz_upload_image: "postiz_upload_image",
};

export function normalizeToolName(name: string): string {
  return V1_TOOL_NAMES[name] ?? name;
}

function toolOutput(content: V2ToolContent["state"]["content"]): string {
  if (!content) {
    return "";
  }

  return content
    .map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

export interface ToolAttachmentLike {
  mime: string;
  url: string;
  filename?: string;
}

/**
 * Files a tool returned, in the shape the summary pipeline expects.
 *
 * V1 tools answered with `attachments: [{ mime, url, filename }]`, and the bot forwards an
 * image to Telegram from exactly that field. V2 carries the same thing as `file` content
 * items, so the two are translated rather than teaching every consumer a second vocabulary.
 *
 * The parameter is `unknown` because two callers hold the content at different levels of
 * typing: the message mapper has a typed message, while the live event normalizer only has
 * the raw event payload. Both end up in the same shape here, so the check is done on the
 * value instead of on the type.
 */
export function collectToolAttachments(content: unknown): ToolAttachmentLike[] | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const attachments: ToolAttachmentLike[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "file") continue;
    if (typeof record.uri !== "string" || record.uri.length === 0) continue;

    attachments.push({
      mime:
        typeof record.mime === "string" && record.mime.length > 0
          ? record.mime
          : "application/octet-stream",
      url: record.uri,
      ...(typeof record.name === "string" && record.name.length > 0
        ? { filename: record.name }
        : {}),
    });
  }

  return attachments.length > 0 ? attachments : undefined;
}

function toolErrorMessage(error: V2ToolContent["state"]["error"]): string {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error.message === "string") {
    return error.message;
  }

  return "Tool failed";
}

function mapToolState(part: V2ToolContent, fallbackStart: number): Record<string, unknown> {
  const state = part.state ?? { status: "pending" };
  const start = part.time?.created ?? fallbackStart;
  const end = part.time?.completed ?? part.time?.ran ?? start;
  const input = state.input ?? {};
  const name = normalizeToolName(part.name);

  if (state.status === "completed") {
    const attachments = collectToolAttachments(state.content);
    return {
      status: "completed",
      input,
      output: toolOutput(state.content),
      title: name,
      metadata: state.metadata ?? {},
      ...(attachments ? { attachments } : {}),
      time: { start, end },
    };
  }

  if (state.status === "error") {
    return {
      status: "error",
      input,
      error: toolErrorMessage(state.error),
      metadata: state.metadata ?? {},
      time: { start, end },
    };
  }

  return {
    status: "running",
    input,
    title: name,
    metadata: state.metadata ?? {},
    time: { start },
  };
}

function mapContentParts(
  message: { id: string; time: { created: number } },
  sessionID: string,
  content: V2MessageContent[] | undefined,
): Array<Record<string, unknown>> {
  if (!content) {
    return [];
  }

  const parts: Array<Record<string, unknown>> = [];

  content.forEach((part, index) => {
    if (part.type === "text") {
      parts.push({
        id: `${message.id}-text-${index}`,
        sessionID,
        messageID: message.id,
        type: "text",
        text: part.text,
        time: { start: part.time?.created ?? message.time.created, ...(part.time?.completed ? { end: part.time.completed } : {}) },
      });
      return;
    }

    if (part.type === "reasoning") {
      parts.push({
        id: `${message.id}-reasoning-${index}`,
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: part.text,
        time: { start: part.time?.created ?? message.time.created, ...(part.time?.completed ? { end: part.time.completed } : {}) },
      });
      return;
    }

    if (part.type === "tool") {
      parts.push({
        id: `${message.id}-tool-${part.id}`,
        sessionID,
        messageID: message.id,
        type: "tool",
        callID: part.id,
        tool: normalizeToolName(part.name),
        state: mapToolState(part, message.time.created),
      });
      return;
    }

    const filename = fileText(part);
    if (filename) {
      parts.push({
        id: `${message.id}-file-${index}`,
        sessionID,
        messageID: message.id,
        type: "file",
        filename,
        mime: part.mime ?? "application/octet-stream",
        url: "",
      });
    }
  });

  return parts;
}

function mapUserMessage(
  message: Extract<V2Message, { type: "user" }>,
  sessionID: string,
): MessageWithPartsLike {
  const text = message.text ?? "";
  const parts: Array<Record<string, unknown>> = [];

  if (text.length > 0) {
    parts.push({
      id: `${message.id}-text-0`,
      sessionID,
      messageID: message.id,
      type: "text",
      text,
    });
  }

  return {
    info: {
      id: message.id,
      sessionID,
      role: "user",
      time: { created: message.time.created },
      agent: "",
      providerID: "",
      modelID: "",
    },
    parts,
  };
}

function mapAssistantMessage(
  message: Extract<V2Message, { type: "assistant" }>,
  sessionID: string,
): MessageWithPartsLike {
  const info: MessageInfoLike = {
    id: message.id,
    sessionID,
    role: "assistant",
    time: {
      created: message.time.created,
      ...(message.time.completed ? { completed: message.time.completed } : {}),
    },
    ...(message.agent ? { agent: message.agent } : {}),
    ...(message.model?.providerID ? { providerID: message.model.providerID } : {}),
    ...(message.model?.id ? { modelID: message.model.id } : {}),
    ...(message.model?.variant ? { variant: message.model.variant } : {}),
    cost: message.cost ?? 0,
    tokens: normalizeTokens(message.tokens),
    ...(message.finish ? { finish: message.finish } : {}),
    ...(message.error
      ? {
          error: {
            name: message.error.type ?? "unknown",
            data: { message: message.error.message ?? "Unknown error" },
          },
        }
      : {}),
  };

  return { info, parts: mapContentParts(message, sessionID, message.content) };
}

/**
 * V2 returns messages newest-first and includes a synthetic `idle` marker.
 * V1 returns oldest-first `{ info, parts }` entries with no marker.
 */
export function mapMessages(
  messages: V2Message[],
  sessionID: string,
  limit?: number,
): MessageWithPartsLike[] {
  const items = messages
    .filter((message): message is V2Message & { type: "user" | "assistant" } =>
      message.type === "user" || message.type === "assistant",
    )
    .map((message) =>
      message.type === "user"
        ? mapUserMessage(message, sessionID)
        : mapAssistantMessage(message, sessionID),
    )
    .sort((left, right) => left.info.time.created - right.info.time.created);

  if (limit !== undefined && limit > 0 && items.length > limit) {
    return items.slice(-limit);
  }

  return items;
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function mapCapabilityInput(model: V2Model): Record<string, boolean> {
  const input = model.capabilities?.input ?? [];
  const includes = (name: string) => input.includes(name);

  return {
    text: input.length === 0 ? true : includes("text"),
    audio: includes("audio"),
    image: includes("image"),
    video: includes("video"),
    pdf: includes("pdf"),
  };
}

function mapCapabilityOutput(model: V2Model): Record<string, boolean> {
  const output = model.capabilities?.output ?? [];
  const includes = (name: string) => output.includes(name);

  return {
    text: output.length === 0 ? true : includes("text"),
    audio: includes("audio"),
    image: includes("image"),
    video: includes("video"),
    pdf: includes("pdf"),
  };
}

function mapModelToV1(model: V2Model): Record<string, unknown> {
  const rate = model.cost?.[0] ?? {};
  const variants = model.variants?.length
    ? Object.fromEntries(model.variants.map((variant) => [variant.id, {}]))
    : undefined;

  return {
    id: model.modelID,
    providerID: model.providerID,
    name: model.name ?? model.modelID,
    family: model.providerID,
    api: {
      id: model.id,
      url: typeof model.settings?.baseURL === "string" ? model.settings.baseURL : "",
      npm: model.package ?? "",
    },
    capabilities: {
      temperature: toBoolean(model.capabilities?.temperature),
      reasoning: false,
      attachment: Boolean(mapCapabilityInput(model).image || mapCapabilityInput(model).pdf),
      toolcall: toBoolean(model.capabilities?.tools),
      input: mapCapabilityInput(model),
      output: mapCapabilityOutput(model),
      interleaved: false,
    },
    cost: {
      input: rate.input ?? 0,
      output: rate.output ?? 0,
      cache: { read: rate.cache?.read ?? 0, write: rate.cache?.write ?? 0 },
    },
    limit: {
      context: model.limit?.context ?? 0,
      output: model.limit?.output ?? 0,
    },
    status: model.status ?? "active",
    options: {},
    headers: model.headers ?? {},
    release_date: model.time?.released ? new Date(model.time.released).toISOString() : "",
    ...(variants ? { variants } : {}),
  };
}

/**
 * V2 splits the catalog: `/api/provider` lists providers without models and
 * `/api/model` lists every model. The bot expects `provider.models` to be a
 * modelID-keyed record, so the two are joined here.
 */
export function mapProviderCatalog(
  providers: V2Provider[],
  models: V2Model[],
): { providers: ProviderLike[] } {
  const byProvider = new Map<string, Record<string, Record<string, unknown>>>();

  for (const model of models) {
    if (model.enabled === false) {
      continue;
    }

    let bucket = byProvider.get(model.providerID);
    if (!bucket) {
      bucket = {};
      byProvider.set(model.providerID, bucket);
    }

    bucket[model.modelID] = mapModelToV1(model);
  }

  return {
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name ?? provider.id,
      source: "config",
      env: [],
      options: {},
      models: byProvider.get(provider.id) ?? {},
    })),
  };
}

function mapAgentMode(mode: string | undefined): "subagent" | "primary" | "all" {
  if (mode === "subagent" || mode === "primary" || mode === "all") {
    return mode;
  }

  return "all";
}

export function mapAgents(agents: V2Agent[]): AgentLike[] {
  return agents.map((agent) => ({
    name: agent.id,
    ...(agent.description ? { description: agent.description } : {}),
    mode: mapAgentMode(agent.mode),
    hidden: agent.hidden === true,
    permission: (agent.permissions ?? []).map((rule) => ({
      permission: rule.action,
      pattern: rule.resource,
      action: rule.effect,
    })),
  }));
}

export function mapCommandCatalog(commands: V2Command[], skills: V2Skill[]): CommandLike[] {
  const mapped: CommandLike[] = commands.map((command) => ({
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
    source: "command",
    template: "",
    hints: [],
  }));

  for (const skill of skills) {
    mapped.push({
      name: skill.id,
      ...(skill.description ? { description: skill.description } : {}),
      source: "skill",
      template: "",
      hints: [],
    });
  }

  return mapped;
}

export function mapProjects(projects: V2Project[]): Array<{
  id: string;
  worktree: string;
  name: string;
  time: { created: number; updated: number };
}> {
  return projects.map((project) => ({
    id: project.id,
    worktree: project.canonical,
    name: project.canonical,
    time: { created: project.time?.created ?? 0, updated: project.time?.updated ?? 0 },
  }));
}

export function mapPermissionRequest(request: V2PermissionRequest): {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
} {
  const tool =
    request.source?.type === "tool" && request.source.messageID && request.source.id
      ? { messageID: request.source.messageID, callID: request.source.id }
      : undefined;

  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action,
    patterns: request.resources ?? [],
    metadata: {},
    always: request.save ?? [],
    ...(tool ? { tool } : {}),
  };
}

export function mapFormToQuestion(form: V2Form): {
  id: string;
  sessionID: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
  tool?: { messageID: string; callID: string };
} {
  const questions = (form.fields ?? []).map((field) => ({
    question: field.description ?? field.title ?? "",
    header: field.title ?? field.key,
    options: (field.options ?? []).map((option) => ({
      label: option.label ?? option.value ?? "",
      description: option.description ?? "",
    })),
    ...(field.multiple !== undefined ? { multiple: field.multiple } : {}),
    ...(field.custom !== undefined ? { custom: field.custom } : {}),
  }));

  const tool =
    form.metadata?.tool?.messageID && form.metadata.tool.id
      ? { messageID: form.metadata.tool.messageID, callID: form.metadata.tool.id }
      : undefined;

  return {
    id: form.id,
    sessionID: form.sessionID,
    questions,
    ...(tool ? { tool } : {}),
  };
}

export function mapFileDiffs(diffs: V2FileDiff[]): Array<{
  file: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: string;
}> {
  return diffs.map((diff) => ({
    file: diff.file,
    ...(diff.patch ? { patch: diff.patch } : {}),
    additions: diff.additions ?? 0,
    deletions: diff.deletions ?? 0,
    ...(diff.status ? { status: diff.status } : {}),
  }));
}
