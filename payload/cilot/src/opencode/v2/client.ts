/**
 * V1-shaped facade over the OpenCode V2 HTTP API.
 *
 * The bot calls the SDK client with flat parameters
 * (`session.messages({ sessionID, directory, limit })`) and reads V1 payloads.
 * This factory returns an object with the same surface, backed by the V2
 * endpoints, so the business logic never learns which API flavor is running.
 */
import { OpencodeV2Http, type OpencodeV2Error, type OpencodeV2Result } from "./http.js";
import { normalizeEventStream, type V1EventLike } from "./event-normalizer.js";
import {
  mapAgents,
  mapCommandCatalog,
  mapFileDiffs,
  mapFormToQuestion,
  mapMessages,
  mapPermissionRequest,
  mapProjects,
  mapProviderCatalog,
  mapSession,
  type CommandLike,
  type MessageWithPartsLike,
  type ProviderLike,
} from "./mappers.js";
import type {
  V2Agent,
  V2Command,
  V2FileDiff,
  V2Form,
  V2McpServer,
  V2Message,
  V2Model,
  V2PermissionRequest,
  V2Project,
  V2Provider,
  V2Session,
  V2Skill,
} from "./types.js";

export interface OpencodeV2ClientOptions {
  baseUrl: string;
  username: string;
  password?: string;
}

export interface V2PromptPart {
  type: string;
  text?: string;
  mime?: string;
  filename?: string;
  url?: string;
}

export interface V2PromptOptions {
  sessionID: string;
  directory?: string;
  parts: V2PromptPart[];
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  system?: string;
}

export interface V2EventSubscription {
  stream: AsyncGenerator<V1EventLike>;
}

type Envelope<T> = { location?: unknown; data: T };

function isEnvelope(value: unknown): value is { data: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "data" in (value as Record<string, unknown>)
  );
}

/** Most V2 routes answer `{ location, data }`; `/api/project` answers a bare array. */
function unwrap<T>(result: OpencodeV2Result<Envelope<T> | T>): OpencodeV2Result<T> {
  if (result.error) {
    return { error: result.error };
  }

  const raw = result.data;
  if (raw === undefined) {
    return {};
  }

  if (isEnvelope(raw)) {
    return { data: raw.data as T };
  }

  return { data: raw as T };
}

function notFound(message: string): OpencodeV2Result<never> {
  return { error: { name: "NotFoundError", data: { message } } };
}

/**
 * Location-scoped routes take a nested `location` query object, serialized as
 * `location[directory]`. A flat `directory` parameter is silently ignored.
 */
function locationQuery(directory?: string): Record<string, string> {
  return directory ? { "location[directory]": directory } : {};
}

function buildPromptBody(options: V2PromptOptions): Record<string, unknown> {
  const promptText = options.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");

  // V2 has no per-turn system prompt, so it is prepended to the user text.
  const text = options.system ? `${options.system}\n\n${promptText}` : promptText;

  const files = options.parts
    .filter((part) => part.type === "file" && part.url)
    .map((part) => ({
      uri: part.url as string,
      ...(part.filename ? { name: part.filename } : {}),
    }));

  return {
    text,
    ...(files.length > 0 ? { files } : {}),
  };
}

export function createOpencodeV2Client(options: OpencodeV2ClientOptions) {
  const http = new OpencodeV2Http(options);

  /**
   * V1 accepted the model/agent/variant on each prompt; V2 stores them on the
   * session instead, so they are applied before the turn is sent.
   */
  async function applyPromptTarget(target: {
    sessionID: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
    variant?: string;
  }): Promise<OpencodeV2Error | null> {
    if (target.model) {
      const applied = await http.request("POST", `/api/session/${target.sessionID}/model`, {
        body: {
          model: {
            providerID: target.model.providerID,
            id: target.model.modelID,
            ...(target.variant ? { variant: target.variant } : {}),
          },
        },
      });

      if (applied.error) {
        return applied.error;
      }
    }

    if (target.agent) {
      const applied = await http.request("POST", `/api/session/${target.sessionID}/agent`, {
        body: { agent: target.agent },
      });

      if (applied.error) {
        return applied.error;
      }
    }

    return null;
  }

  async function listPermissionRequests(directory?: string) {
    const result = unwrap<V2PermissionRequest[]>(
      await http.request("GET", "/api/permission/request", {
        query: locationQuery(directory),
      }),
    );
    return result;
  }

  async function listForms(directory?: string) {
    const result = unwrap<V2Form[]>(
      await http.request("GET", "/api/form", { query: locationQuery(directory) }),
    );
    return result;
  }

  async function fetchSession(sessionID: string) {
    return unwrap<V2Session>(await http.request("GET", `/api/session/${sessionID}`));
  }

  return {
    global: {
      async health(requestOptions?: { signal?: AbortSignal }) {
        const signal = requestOptions?.signal;
        const result = unwrap<{ version?: string }>(
          await http.request("GET", "/api/info", signal ? { signal } : {}),
        );

        if (result.error) {
          return result;
        }

        return { data: { healthy: true, version: result.data?.version ?? "" } };
      },
    },

    app: {
      async agents(params?: { directory?: string }) {
        const result = unwrap<V2Agent[]>(
          await http.request("GET", "/api/agent", {
            query: locationQuery(params?.directory),
          }),
        );

        if (result.error) {
          return result;
        }

        return { data: mapAgents(result.data ?? []) };
      },
    },

    config: {
      async providers(): Promise<OpencodeV2Result<{ providers: ProviderLike[] }>> {
        const [providerResult, modelResult] = await Promise.all([
          unwrap<V2Provider[]>(await http.request("GET", "/api/provider")),
          unwrap<V2Model[]>(await http.request("GET", "/api/model")),
        ]);

        if (providerResult.error) {
          return { error: providerResult.error };
        }
        if (modelResult.error) {
          return { error: modelResult.error };
        }

        return { data: mapProviderCatalog(providerResult.data ?? [], modelResult.data ?? []) };
      },
    },

    project: {
      async list() {
        const result = unwrap<V2Project[]>(await http.request("GET", "/api/project"));
        if (result.error) {
          return result;
        }

        return { data: mapProjects(result.data ?? []) };
      },
    },

    session: {
      async list(params: { directory?: string; limit?: number; roots?: boolean }) {
        const result = unwrap<V2Session[]>(
          await http.request("GET", "/api/session", {
            query: {
              directory: params.directory,
              limit: params.limit,
              order: "desc",
              ...(params.roots ? { parentID: "null" } : {}),
            },
          }),
        );

        if (result.error) {
          return result;
        }

        return { data: (result.data ?? []).map(mapSession) };
      },

      async create(params: { directory: string; title?: string; agent?: string }) {
        const result = unwrap<V2Session>(
          await http.request("POST", "/api/session", {
            body: {
              location: { directory: params.directory },
              ...(params.title ? { title: params.title } : {}),
              ...(params.agent ? { agent: params.agent } : {}),
            },
          }),
        );

        if (result.error) {
          return result;
        }

        return { data: result.data ? mapSession(result.data) : undefined };
      },

      async get(params: { sessionID: string }) {
        const result = await fetchSession(params.sessionID);
        if (result.error) {
          return result;
        }

        return { data: result.data ? mapSession(result.data) : undefined };
      },

      async update(params: { sessionID: string; title?: string }) {
        const update = await http.request("PATCH", `/api/session/${params.sessionID}`, {
          body: { title: params.title ?? "" },
        });

        if (update.error) {
          return update;
        }

        const result = await fetchSession(params.sessionID);
        if (result.error) {
          return result;
        }

        return { data: result.data ? mapSession(result.data) : undefined };
      },

      async delete(params: { sessionID: string }) {
        return http.request("DELETE", `/api/session/${params.sessionID}`);
      },

      async abort(params: { sessionID: string }, requestOptions?: { signal?: AbortSignal }) {
        const signal = requestOptions?.signal;
        const result = await http.request(
          "POST",
          `/api/session/${params.sessionID}/interrupt`,
          signal ? { signal } : {},
        );

        if (result.error) {
          return result;
        }

        return { data: true };
      },

      async status(_params: { directory?: string }) {
        const result = unwrap<Record<string, { type?: string }>>(
          await http.request("GET", "/api/session/active"),
        );

        if (result.error) {
          return result;
        }

        const statuses: Record<string, { type: string }> = {};
        for (const [sessionID, value] of Object.entries(result.data ?? {})) {
          statuses[sessionID] = { type: value?.type === "running" ? "busy" : value?.type ?? "idle" };
        }

        return { data: statuses };
      },

      async summarize(params: { sessionID: string }) {
        return http.request("POST", `/api/session/${params.sessionID}/compact`, { body: {} });
      },

      async revert(params: { sessionID: string; messageID: string }) {
        return http.request("POST", `/api/session/${params.sessionID}/revert/stage`, {
          body: { messageID: params.messageID },
        });
      },

      async messages(params: { sessionID: string; directory?: string; limit?: number }) {
        const result = unwrap<V2Message[]>(
          await http.request("GET", `/api/session/${params.sessionID}/message`, {
            query: { limit: params.limit, order: "desc" },
          }),
        );

        if (result.error) {
          return result;
        }

        return { data: mapMessages(result.data ?? [], params.sessionID, params.limit) };
      },

      async prompt(options: V2PromptOptions): Promise<OpencodeV2Result<MessageWithPartsLike>> {
        const targetError = await applyPromptTarget(options);
        if (targetError) {
          return { error: targetError };
        }

        const sent = await http.request(
          "POST",
          `/api/session/${options.sessionID}/prompt`,
          { body: buildPromptBody(options) },
        );

        if (sent.error) {
          return { error: sent.error };
        }

        const waited = await http.request(
          "POST",
          `/api/experimental/session/${options.sessionID}/wait`,
          { body: {} },
        );

        if (waited.error) {
          return { error: waited.error };
        }

        const messages = await unwrap<V2Message[]>(
          await http.request("GET", `/api/session/${options.sessionID}/message`, {
            query: { order: "desc" },
          }),
        );

        if (messages.error) {
          return { error: messages.error };
        }

        const mapped = mapMessages(messages.data ?? [], options.sessionID);
        const assistant = [...mapped].reverse().find((message) => message.info.role === "assistant");
        if (!assistant) {
          return notFound("No assistant response received");
        }

        return { data: assistant };
      },

      async promptAsync(options: V2PromptOptions) {
        const targetError = await applyPromptTarget(options);
        if (targetError) {
          return { error: targetError };
        }

        return http.request("POST", `/api/session/${options.sessionID}/prompt`, {
          body: buildPromptBody(options),
        });
      },

      async fork(params: { sessionID: string; messageID: string }) {
        const result = unwrap<V2Session>(
          await http.request("POST", `/api/session/${params.sessionID}/fork`, {
            body: { before: params.messageID },
          }),
        );

        if (result.error) {
          return result;
        }

        return { data: result.data ? mapSession(result.data) : undefined };
      },

      async diff(params: { sessionID: string; directory?: string }) {
        const result = unwrap<V2FileDiff[]>(
          await http.request("GET", `/api/session/${params.sessionID}/diff`),
        );

        if (result.error) {
          return result;
        }

        return { data: mapFileDiffs(result.data ?? []) };
      },

      async command(params: {
        sessionID: string;
        directory?: string;
        command: string;
        arguments?: string;
        agent?: string;
        model?: { providerID: string; modelID: string };
        variant?: string;
      }) {
        const targetError = await applyPromptTarget(params);
        if (targetError) {
          return { error: targetError };
        }

        return http.request("POST", `/api/session/${params.sessionID}/command`, {
          body: {
            name: params.command,
            text: params.arguments ?? "",
          },
        });
      },
    },

    permission: {
      async list(params: { directory?: string }) {
        const result = await listPermissionRequests(params.directory);
        if (result.error) {
          return result;
        }

        return { data: (result.data ?? []).map(mapPermissionRequest) };
      },

      async reply(params: {
        requestID: string;
        directory?: string;
        reply: string;
        message?: string;
      }) {
        const pending = await listPermissionRequests(params.directory);
        if (pending.error) {
          return pending;
        }

        const request = (pending.data ?? []).find((item) => item.id === params.requestID);
        if (!request) {
          return notFound(`Permission request not found: ${params.requestID}`);
        }

        return http.request(
          "POST",
          `/api/session/${request.sessionID}/permission/${params.requestID}/reply`,
          {
            body: {
              decision: params.reply,
              ...(params.message ? { message: params.message } : {}),
            },
          },
        );
      },
    },

    question: {
      async list(params: { directory?: string }) {
        const result = await listForms(params.directory);
        if (result.error) {
          return result;
        }

        const questions = (result.data ?? [])
          .filter((form) => (form.metadata?.kind ?? "question") === "question")
          .map(mapFormToQuestion);

        return { data: questions };
      },

      async reply(params: { requestID: string; directory?: string; answers: string[][] }) {
        const pending = await listForms(params.directory);
        if (pending.error) {
          return pending;
        }

        const form = (pending.data ?? []).find((item) => item.id === params.requestID);
        if (!form) {
          return notFound(`Question request not found: ${params.requestID}`);
        }

        const fields = form.fields ?? [];
        const answer: Record<string, string | string[]> = {};
        fields.forEach((field, index) => {
          const values = params.answers[index] ?? [];
          const [first] = values;
          if (first === undefined) {
            return;
          }
          answer[field.key] = values.length > 1 ? values : first;
        });

        return http.request("POST", `/api/session/${form.sessionID}/form/${form.id}/reply`, {
          body: { answer },
        });
      },

      async reject(params: { requestID: string; directory?: string }) {
        const pending = await listForms(params.directory);
        if (pending.error) {
          return pending;
        }

        const form = (pending.data ?? []).find((item) => item.id === params.requestID);
        if (!form) {
          return notFound(`Question request not found: ${params.requestID}`);
        }

        return http.request("DELETE", `/api/session/${form.sessionID}/form/${form.id}`);
      },
    },

    command: {
      async list(params: { directory?: string }): Promise<OpencodeV2Result<CommandLike[]>> {
        const [commandResult, skillResult] = await Promise.all([
          unwrap<V2Command[]>(
            await http.request("GET", "/api/command", {
              query: locationQuery(params.directory),
            }),
          ),
          unwrap<V2Skill[]>(
            await http.request("GET", "/api/skill", {
              query: locationQuery(params.directory),
            }),
          ),
        ]);

        if (commandResult.error) {
          return { error: commandResult.error };
        }
        if (skillResult.error) {
          return { error: skillResult.error };
        }

        return {
          data: mapCommandCatalog(commandResult.data ?? [], skillResult.data ?? []),
        };
      },
    },

    mcp: {
      async status(params: { directory?: string }) {
        const result = unwrap<V2McpServer[]>(
          await http.request("GET", "/api/mcp", { query: locationQuery(params.directory) }),
        );

        if (result.error) {
          return result;
        }

        return {
          data: (result.data ?? []).map((server) => ({
            name: server.name,
            status: server.status ?? { status: "disabled" },
          })),
        };
      },

      async connect(params: { name: string; directory?: string }) {
        return http.request(
          "POST",
          `/api/experimental/mcp/${encodeURIComponent(params.name)}/connect`,
          { body: {}, query: locationQuery(params.directory) },
        );
      },

      async disconnect(params: { name: string; directory?: string }) {
        return http.request(
          "POST",
          `/api/experimental/mcp/${encodeURIComponent(params.name)}/disconnect`,
          { body: {}, query: locationQuery(params.directory) },
        );
      },
    },

    event: {
      async subscribe(
        params: { directory: string },
        options?: { signal?: AbortSignal },
      ): Promise<V2EventSubscription> {
        const source = http.stream("/api/event", options?.signal);
        return { stream: normalizeEventStream(source, params.directory) };
      },
    },
  };
}

export type OpencodeV2Client = ReturnType<typeof createOpencodeV2Client>;
