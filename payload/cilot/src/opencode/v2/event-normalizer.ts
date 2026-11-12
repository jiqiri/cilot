/**
 * Translates the V2 event stream into the V1 event contract.
 *
 * Everything downstream (`events.ts`, `event-router.ts`,
 * `summary-aggregation-manager.ts`, the MCP catalog) consumes V1 events:
 * `{ type, properties }`. V2 instead emits fine-grained domain events
 * (`session.step.started`, `session.text.delta`, ...) carrying their payload
 * under `data` and the project under `location`. This class rebuilds the V1
 * stream from them, keeping the aggregation logic untouched.
 *
 * V2 has no heartbeat event, so nothing is emitted for the connection-level
 * events (`server.connected`, `provider.updated`, ...).
 */

import {
  collectToolAttachments,
  mapPermissionRequest,
  mapSessionFromEvent,
  normalizeToolName,
} from "./mappers.js";
import type { V2PermissionRequest } from "./types.js";

export interface V1EventLike {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

function normalizeDirectory(directory: string): string {
  const normalized = directory.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isSameDirectory(left: string, right: string): boolean {
  return normalizeDirectory(left) === normalizeDirectory(right);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(value: unknown): string {
  const record = asRecord(value);
  if (record && typeof record.message === "string") {
    return record.message;
  }

  return typeof value === "string" ? value : "Unknown error";
}

export class V2EventNormalizer {
  /** Accumulated text per synthesized part, keyed by part id. */
  private readonly textBuffers = new Map<string, string>();
  /** Tool name and input per call id, filled before the tool runs. */
  private readonly toolNames = new Map<string, string>();
  private readonly toolInputs = new Map<string, Record<string, unknown>>();
  private readonly messageStartedAt = new Map<string, number>();
  private sequence = 0;

  constructor(private readonly directory: string) {}

  /** Returns the V1 events synthesized from one V2 event, possibly none. */
  normalize(raw: unknown): V1EventLike[] {
    const event = asRecord(raw);
    if (!event || typeof event.type !== "string") {
      return [];
    }

    const location = asRecord(event.location);
    const eventDirectory = location ? asString(location.directory) : undefined;
    if (eventDirectory && !isSameDirectory(eventDirectory, this.directory)) {
      return [];
    }

    const data = asRecord(event.data) ?? {};
    const createdAt = asNumber(event.created) ?? Date.now();
    const sessionID = asString(data.sessionID);
    if (!sessionID) {
      return [];
    }

    switch (event.type) {
      case "session.created":
        return [this.emit("session.created", { info: mapSessionFromEvent(data, createdAt) })];

      case "session.inbox.enqueued":
        return this.normalizeInboxEnqueued(data, sessionID, createdAt);

      case "session.execution.started":
        return [this.status("busy", sessionID)];

      case "session.step.started":
        return this.normalizeStepStarted(data, sessionID, createdAt);

      case "session.step.ended":
        return this.normalizeStepEnded(data, sessionID, createdAt);

      case "session.reasoning.delta":
        return this.normalizeDelta("reasoning", data, sessionID);

      case "session.reasoning.ended":
        return this.normalizeEndedPart("reasoning", data, sessionID, createdAt);

      case "session.text.delta":
        return this.normalizeDelta("text", data, sessionID);

      case "session.text.ended":
        return this.normalizeEndedPart("text", data, sessionID, createdAt);

      case "session.tool.input.started":
        return this.normalizeToolInputStarted(data, sessionID, createdAt);

      case "session.tool.called":
        return this.normalizeToolCalled(data, sessionID, createdAt);

      case "session.tool.success":
        return this.normalizeToolSuccess(data, sessionID, createdAt);

      case "session.tool.failed":
        return this.normalizeToolFailed(data, sessionID, createdAt);

      case "session.retry.scheduled":
        return this.normalizeRetry(data, sessionID);

      case "session.execution.succeeded":
      case "session.execution.interrupted":
        return [this.emit("session.idle", { sessionID }), this.status("idle", sessionID)];

      case "session.execution.failed":
        return this.normalizeExecutionFailed(data, sessionID);

      case "session.compaction.ended":
        return [this.emit("session.compacted", { sessionID })];

      case "permission.asked":
        return [
          this.emit(
            "permission.asked",
            mapPermissionRequest(data as unknown as V2PermissionRequest),
          ),
        ];

      case "permission.replied":
        return [
          this.emit("permission.replied", {
            sessionID,
            requestID: asString(data.requestID) ?? "",
            reply: asString(data.reply) ?? "reject",
          }),
        ];

      case "form.created":
        return this.normalizeFormCreated(data);

      case "form.replied":
        return this.normalizeFormReplied(data, sessionID);

      case "form.cancelled":
        return [
          this.emit("question.rejected", {
            sessionID,
            requestID: asString(data.id) ?? "",
          }),
        ];

      default:
        return [];
    }
  }

  private normalizeInboxEnqueued(
    data: Record<string, unknown>,
    sessionID: string,
    createdAt: number,
  ): V1EventLike[] {
    const inboxID = asString(data.inboxID);
    const item = asRecord(data.item);
    const payload = item ? asRecord(item.payload) : null;
    const text = payload ? asString(payload.text) ?? "" : "";
    if (!inboxID) {
      return [];
    }

    const events: V1EventLike[] = [
      this.emit("message.updated", {
        sessionID,
        info: {
          id: inboxID,
          sessionID,
          role: "user",
          time: { created: createdAt },
          agent: "",
          providerID: "",
          modelID: "",
        },
      }),
    ];

    if (text.length > 0) {
      events.push(
        this.emit("message.part.updated", {
          sessionID,
          time: createdAt,
          part: {
            id: `${inboxID}-text-0`,
            sessionID,
            messageID: inboxID,
            type: "text",
            text,
          },
        }),
      );
    }

    return events;
  }

  private normalizeStepStarted(
    data: Record<string, unknown>,
    sessionID: string,
    createdAt: number,
  ): V1EventLike[] {
    const messageID = asString(data.assistantMessageID);
    if (!messageID) {
      return [];
    }

    const started = asNumber(data.started) ?? createdAt;
    this.messageStartedAt.set(messageID, started);

    const model = asRecord(data.model);
    const agent = asString(data.agent);
    const providerID = model ? asString(model.providerID) : undefined;
    const modelID = model ? asString(model.id) : undefined;
    const variant = model ? asString(model.variant) : undefined;

    return [
      this.emit("message.updated", {
        sessionID,
        info: {
          id: messageID,
          sessionID,
          role: "assistant",
          time: { created: started },
          ...(agent ? { agent } : {}),
          ...(providerID ? { providerID } : {}),
          ...(modelID ? { modelID } : {}),
          ...(variant ? { variant } : {}),
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      }),
    ];
  }

  private normalizeStepEnded(
    data: Record<string, unknown>,
    sessionID: string,
    createdAt: number,
  ): V1EventLike[] {
    const messageID = asString(data.assistantMessageID);
    if (!messageID) {
      return [];
    }

    const started = this.messageStartedAt.get(messageID) ?? createdAt;
    const tokens = asRecord(data.tokens) ?? {};
    const cache = asRecord(tokens.cache) ?? {};
    const finish = asString(data.finish);

    return [
      this.emit("message.updated", {
        sessionID,
        info: {
          id: messageID,
          sessionID,
          role: "assistant",
          time: { created: started, completed: createdAt },
          cost: asNumber(data.cost) ?? 0,
          tokens: {
            input: asNumber(tokens.input) ?? 0,
            output: asNumber(tokens.output) ?? 0,
            reasoning: asNumber(tokens.reasoning) ?? 0,
            cache: {
              read: asNumber(cache.read) ?? 0,
              write: asNumber(cache.write) ?? 0,
            },
          },
          ...(finish ? { finish } : {}),
        },
      }),
    ];
  }

  private normalizeDelta(
    kind: "text" | "reasoning",
    data: Record<string, unknown>,
    sessionID: string,
  ): V1EventLike[] {
    const messageID = asString(data.assistantMessageID);
    const delta = asString(data.delta);
    if (!messageID || !delta) {
      return [];
    }

    const ordinal = asNumber(data.ordinal) ?? 0;
    const partID = `${messageID}-${kind}-${ordinal}`;
    const accumulated = `${this.textBuffers.get(partID) ?? ""}${delta}`;
    this.textBuffers.set(partID, accumulated);

    return [
      this.emit("message.part.delta", {
        sessionID,
        messageID,
        partID,
        field: kind,
        delta,
        part: {
          id: partID,
          sessionID,
          messageID,
          type: kind,
          text: accumulated,
        },
      }),
    ];
  }

  private normalizeEndedPart(
    kind: "text" | "reasoning",
    data: Record<string, unknown>,
    sessionID: string,
    createdAt: number,
  ): V1EventLike[] {
    const messageID = asString(data.assistantMessageID);
    if (!messageID) {
      return [];
    }

    const ordinal = asNumber(data.ordinal) ?? 0;
    const partID = `${messageID}-${kind}-${ordinal}`;
    const text = asString(data.text) ?? this.textBuffers.get(partID) ?? "";
    if (text.length === 0) {
      return [];
    }

    this.textBuffers.set(partID, text);

    return [
      this.emit("message.part.updated", {
        sessionID,
        time: createdAt,
        part: {
          id: partID,
          sessionID,
          messageID,
          type: kind,
          text,
          time: { start: this.messageStartedAt.get(messageID) ?? createdAt, end: createdAt },
        },
      }),
    ];
  }

  private toolPart(
    sessionID: string,
    messageID: string,
    callID: string,
    tool: string,
    state: Record<string, unknown>,
  ): V1EventLike {
    // A tool served by the local MCP server arrives prefixed with the server name. The bot
    // keys behaviour off the V1 name, so both the part and its title are rewritten here,
    // which is the single place every tool event passes through.
    const name = normalizeToolName(tool);
    const normalizedState = typeof state.title === "string" ? { ...state, title: name } : state;

    return this.emit("message.part.updated", {
      sessionID,
      time: Date.now(),
      part: {
        id: `${messageID}-tool-${callID}`,
        sessionID,
        messageID,
        type: "tool",
        callID,
        tool: name,
        state: normalizedState,
      },
    });
  }

  private normalizeToolInputStarted(
    data: Record<string, unknown>,
    sessionID: string,
    createdAt: number,
  ): V1EventLike[] {
    const messageID = asString(data.assistantMessageID);
    const callID = asString(data.id);
    const tool = asString(data.name);
    if (!messageID || !callID || !tool) {
      return [];
    }

    this.toolNames.set(callID, tool);
    this.toolInputs.set(callID, {});

    return [
      this.toolPart(sessionID, messageID, callID, tool, {
        status: "running",
        input: {},
        title: tool,
        time: { start: createdAt },
      }),
    ];
  }

  private normalizeToolCalled(
    data: Record<string, unknown>,
    sessionID: string,
    createdAt: number,
  ): V1EventLike[] {
    const messageID = asString(data.assistantMessageID);
    const callID = asString(data.id);
    if (!messageID || !callID) {
      return [];
    }

    const tool = this.toolNames.get(callID) ?? asString(data.name) ?? "tool";
    const input = asRecord(data.input) ?? {};
    this.toolInputs.set(callID, input);

    return [
      this.toolPart(sessionID, messageID, callID, tool, {
        status: "running",
        input,
        title: tool,
        time: { start: createdAt },
      }),
    ];
  }

  private normalizeToolSuccess(
    data: Record<string, unknown>,
    sessionID: string,
    createdAt: number,
  ): V1EventLike[] {
    const messageID = asString(data.assistantMessageID);
    const callID = asString(data.id);
    if (!messageID || !callID) {
      return [];
    }

    const tool = this.toolNames.get(callID) ?? "tool";
    const content = Array.isArray(data.content) ? data.content : [];
    const output = content
      .map((item) => {
        const record = asRecord(item);
        return record && typeof record.text === "string" ? record.text : "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
    // An MCP tool returns an image as a `file` content item. Without this the bot sees only
    // the text and has nothing to send to Telegram.
    const attachments = collectToolAttachments(data.content);

    return [
      this.toolPart(sessionID, messageID, callID, tool, {
        status: "completed",
        input: this.toolInputs.get(callID) ?? {},
        output,
        title: tool,
        metadata: asRecord(data.metadata) ?? {},
        ...(attachments ? { attachments } : {}),
        time: { start: createdAt, end: createdAt },
      }),
    ];
  }

  private normalizeToolFailed(
    data: Record<string, unknown>,
    sessionID: string,
    createdAt: number,
  ): V1EventLike[] {
    const messageID = asString(data.assistantMessageID);
    const callID = asString(data.id);
    if (!messageID || !callID) {
      return [];
    }

    const tool = this.toolNames.get(callID) ?? "tool";

    return [
      this.toolPart(sessionID, messageID, callID, tool, {
        status: "error",
        input: this.toolInputs.get(callID) ?? {},
        error: errorMessage(data.error),
        time: { start: createdAt, end: createdAt },
      }),
    ];
  }

  private normalizeRetry(
    data: Record<string, unknown>,
    sessionID: string,
  ): V1EventLike[] {
    return [
      this.emit("session.status", {
        sessionID,
        status: {
          type: "retry",
          attempt: asNumber(data.attempt) ?? 0,
          message: errorMessage(data.error),
          next: asNumber(data.at) ?? Date.now(),
        },
      }),
    ];
  }

  private normalizeExecutionFailed(
    data: Record<string, unknown>,
    sessionID: string,
  ): V1EventLike[] {
    const error = asRecord(data.error);
    const name = error ? asString(error.type) ?? "unknown" : "unknown";

    return [
      this.emit("session.error", {
        sessionID,
        error: { name, data: { message: errorMessage(data.error) } },
      }),
      this.emit("session.idle", { sessionID }),
      this.status("idle", sessionID),
    ];
  }

  private normalizeFormCreated(data: Record<string, unknown>): V1EventLike[] {
    const form = asRecord(data.form);
    if (!form) {
      return [];
    }

    const kind = asRecord(form.metadata)?.kind;
    if (typeof kind === "string" && kind !== "question") {
      return [];
    }

    const sessionID = asString(form.sessionID);
    if (!sessionID) {
      return [];
    }

    const fields = Array.isArray(form.fields) ? form.fields : [];
    const questions = fields.map((field) => {
      const record = asRecord(field) ?? {};
      const options = Array.isArray(record.options) ? record.options : [];

      return {
        question: asString(record.description) ?? asString(record.title) ?? "",
        header: asString(record.title) ?? asString(record.key) ?? "",
        options: options.map((option) => {
          const item = asRecord(option) ?? {};
          return {
            label: asString(item.label) ?? asString(item.value) ?? "",
            description: asString(item.description) ?? "",
          };
        }),
        ...(record.multiple !== undefined ? { multiple: record.multiple === true } : {}),
        ...(record.custom !== undefined ? { custom: record.custom === true } : {}),
      };
    });

    const tool = asRecord(asRecord(form.metadata)?.tool);

    return [
      this.emit("question.asked", {
        id: asString(form.id) ?? "",
        sessionID,
        questions,
        ...(tool && tool.messageID && tool.id
          ? { tool: { messageID: tool.messageID, callID: tool.id } }
          : {}),
      }),
    ];
  }

  private normalizeFormReplied(
    data: Record<string, unknown>,
    sessionID: string,
  ): V1EventLike[] {
    const answer = asRecord(data.answer) ?? {};
    const answers = Object.values(answer).map((value) =>
      Array.isArray(value) ? value.map(String) : [String(value)],
    );

    return [
      this.emit("question.replied", {
        sessionID,
        requestID: asString(data.id) ?? "",
        answers,
      }),
    ];
  }

  private status(type: "busy" | "idle", sessionID: string): V1EventLike {
    return this.emit("session.status", { sessionID, status: { type } });
  }

  private emit(type: string, properties: Record<string, unknown>): V1EventLike {
    this.sequence += 1;
    return { id: `v2-${this.sequence}`, type, properties };
  }
}

/**
 * Wraps a raw V2 stream so callers only ever see V1 events for `directory`.
 * Every event carries its own `location.directory`; anything else is dropped so
 * a shared stream never leaks another project's activity into this chat.
 */
export async function* normalizeEventStream(
  source: AsyncGenerator<unknown>,
  directory: string,
): AsyncGenerator<V1EventLike> {
  const normalizer = new V2EventNormalizer(directory);

  for await (const raw of source) {
    for (const normalized of normalizer.normalize(raw)) {
      yield normalized;
    }
  }
}
