import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  type JsonRpcId,
  type JsonRpcRequest,
  type McpTool,
  type ToolResult,
} from "./types.js";

/**
 * The JSON-RPC layer of the MCP server, separated from the stream it runs on.
 *
 * Keeping it free of `process.stdin`/`stdout` means the protocol can be exercised directly:
 * a test hands it a line and reads the frames it writes, with no child process, no pipe
 * buffering and no timing.
 */

export const SERVER_INFO = { name: "opencode-telegram-tools", version: "1.0.0" };

/** Newest first. The version the client asks for is echoed when it is one we know. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface ProtocolIO {
  /** One JSON-RPC frame. The transport adds the newline. */
  write: (message: unknown) => void;
  log?: { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn a tool result into MCP content.
 *
 * An image travels as an `image` content item carrying the base64 payload. That is the
 * standard way for a tool to return a picture, and OpenCode surfaces it as a file part the
 * bot can forward to Telegram. Text is kept first so a reader that ignores the image still
 * gets the path and the instructions.
 */
function toContent(result: ToolResult): unknown[] {
  const content: unknown[] = [];
  if (result.text.length > 0) {
    content.push({ type: "text", text: result.text });
  }

  for (const file of result.files ?? []) {
    const dataUri = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(file.uri);
    if (dataUri) {
      const mime = file.mime || dataUri[1] || "application/octet-stream";
      if (mime.startsWith("image/")) {
        content.push({ type: "image", data: dataUri[2], mimeType: mime });
        continue;
      }
      content.push({ type: "resource", resource: { uri: file.uri, mimeType: mime, blob: dataUri[2] } });
      continue;
    }

    content.push({
      type: "resource_link",
      uri: file.uri,
      mimeType: file.mime,
      ...(file.name ? { name: file.name } : {}),
    });
  }

  // MCP requires at least one content item, and an empty text block is the least surprising
  // filler for a tool that has nothing to say.
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  return content;
}

export interface Protocol {
  /** Handle one line of input. Never throws: every failure becomes a frame. */
  handleLine: (line: string) => Promise<void>;
  /** Abort every call in flight, for shutdown. */
  abortAll: () => void;
}

export function createProtocol(tools: McpTool[], io: ProtocolIO): Protocol {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  /** One entry per running call, so `notifications/cancelled` can abort the fetch behind it. */
  const inFlight = new Map<string, AbortController>();

  const reply = (id: JsonRpcId, result: unknown): void => {
    io.write({ jsonrpc: "2.0", id, result });
  };

  const fail = (id: JsonRpcId, code: number, message: string): void => {
    io.write({ jsonrpc: "2.0", id, error: { code, message } });
  };

  const callTool = async (id: JsonRpcId, params: unknown): Promise<void> => {
    if (!isRecord(params) || typeof params.name !== "string") {
      fail(id, JSON_RPC_INVALID_PARAMS, "tools/call requires a string `name`.");
      return;
    }

    const tool = toolsByName.get(params.name);
    if (!tool) {
      fail(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${params.name}`);
      return;
    }

    const args = isRecord(params.arguments) ? params.arguments : {};
    const controller = new AbortController();
    const key = String(id);
    inFlight.set(key, controller);

    try {
      const result = await tool.run(args, { signal: controller.signal });
      reply(id, {
        content: toContent(result),
        ...(result.metadata ? { _meta: { metadata: result.metadata } } : {}),
      });
    } catch (error) {
      // A tool failure is a result the model must read and act on, not a transport fault: the
      // message is the only thing that tells it what to change.
      const message = error instanceof Error ? error.message : String(error);
      io.log?.warn(`Tool ${tool.name} failed: ${message}`);
      reply(id, { content: [{ type: "text", text: message }], isError: true });
    } finally {
      inFlight.delete(key);
    }
  };

  const handleRequest = async (request: JsonRpcRequest): Promise<void> => {
    const id = request.id ?? null;

    switch (request.method) {
      case "initialize": {
        const requested = isRecord(request.params) ? request.params.protocolVersion : undefined;
        const protocolVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
        io.log?.info(`initialize (client protocol ${String(requested ?? "unspecified")})`);
        reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
        return;
      }

      case "ping":
        reply(id, {});
        return;

      case "tools/list":
        reply(id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
        return;

      case "tools/call":
        await callTool(id, request.params);
        return;

      default:
        fail(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${request.method}`);
    }
  };

  const handleNotification = (request: JsonRpcRequest): void => {
    if (request.method !== "notifications/cancelled") {
      return;
    }
    const params = isRecord(request.params) ? request.params : {};
    const requestId = params.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      return;
    }
    inFlight.get(String(requestId))?.abort();
  };

  const handleLine = async (line: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(null, JSON_RPC_PARSE_ERROR, "Could not parse the request as JSON.");
      return;
    }

    if (!isRecord(parsed) || typeof parsed.method !== "string") {
      fail(null, JSON_RPC_INVALID_PARAMS, "Expected a JSON-RPC request with a `method`.");
      return;
    }

    const request = parsed as unknown as JsonRpcRequest;
    if (request.id === undefined) {
      handleNotification(request);
      return;
    }

    try {
      await handleRequest(request);
    } catch (error) {
      io.log?.error(`Unhandled failure in ${request.method}: ${(error as Error).message}`);
      fail(request.id ?? null, JSON_RPC_INTERNAL_ERROR, "Internal error");
    }
  };

  return {
    handleLine,
    abortAll: () => {
      for (const controller of inFlight.values()) controller.abort();
    },
  };
}
