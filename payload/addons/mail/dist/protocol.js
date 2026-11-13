const PROTOCOL_VERSION = "2025-06-18";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toContent(result) {
    const content = [];
    if (result.text.length > 0) {
        content.push({ type: "text", text: result.text });
    }
    for (const file of result.files ?? []) {
        const dataUri = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(file.uri);
        if (dataUri && (file.mime ?? dataUri[1] ?? "").startsWith("image/")) {
            content.push({
                type: "image",
                data: dataUri[2],
                mimeType: file.mime ?? dataUri[1],
            });
            continue;
        }
        content.push({
            type: "resource_link",
            uri: file.uri,
            ...(file.mime ? { mimeType: file.mime } : {}),
            ...(file.name ? { name: file.name } : {}),
        });
    }
    if (content.length === 0) {
        content.push({ type: "text", text: "" });
    }
    return content;
}
export function createProtocol(tools, io) {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const inFlight = new Map();
    const reply = (id, result) => {
        io.write({ jsonrpc: "2.0", id, result });
    };
    const fail = (id, code, message) => {
        io.write({ jsonrpc: "2.0", id, error: { code, message } });
    };
    const call = async (id, params) => {
        if (!isRecord(params) || typeof params.name !== "string") {
            fail(id, -32602, "tools/call requires a string `name`.");
            return;
        }
        const tool = byName.get(params.name);
        if (!tool) {
            fail(id, -32602, `Unknown tool: ${params.name}`);
            return;
        }
        const args = isRecord(params.arguments) ? params.arguments : {};
        const controller = new AbortController();
        inFlight.set(String(id), controller);
        try {
            const result = await tool.run(args, { signal: controller.signal });
            reply(id, {
                content: toContent(result),
                ...(result.metadata ? { _meta: { metadata: result.metadata } } : {}),
            });
        }
        catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            io.log(`tool ${tool.name} failed: ${text}`);
            reply(id, { content: [{ type: "text", text }], isError: true });
        }
        finally {
            inFlight.delete(String(id));
        }
    };
    const handleLine = async (line) => {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            fail(null, -32700, "Could not parse the request as JSON.");
            return;
        }
        if (!isRecord(parsed) || typeof parsed.method !== "string") {
            fail(null, -32600, "Expected a JSON-RPC request with a `method`.");
            return;
        }
        const id = parsed.id;
        const method = parsed.method;
        if (id === undefined) {
            if (method === "notifications/cancelled" && isRecord(parsed.params)) {
                const requestId = parsed.params.requestId;
                if (typeof requestId === "string" || typeof requestId === "number") {
                    inFlight.get(String(requestId))?.abort();
                }
            }
            return;
        }
        switch (method) {
            case "initialize": {
                const requested = isRecord(parsed.params) ? parsed.params.protocolVersion : undefined;
                reply(id, {
                    protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: "cilot-addon-mail", version: "1.0.0" },
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
                await call(id, parsed.params);
                return;
            default:
                fail(id, -32601, `Method not found: ${method}`);
        }
    };
    return {
        handleLine,
        abortAll: () => {
            for (const controller of inFlight.values())
                controller.abort();
        },
    };
}
/** Small helper so a tool can stream into a bounded buffer. */
export async function drain(stream, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
            chunks.push(buffer.subarray(0, buffer.length - (total - maxBytes)));
            break;
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}
