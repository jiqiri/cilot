import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProtocol } from "../dist/protocol.js";

/**
 * The JSON-RPC layer is the boundary the model actually talks to. These cases check the
 * two rules that matter for a read-only add-on: a tool failure comes back as a result the
 * model can read, and an unknown method or tool is a protocol error it cannot mistake for
 * success.
 */

function harness(tools = []) {
  const frames = [];
  const logs = [];
  const protocol = createProtocol(tools, {
    write: (frame) => frames.push(frame),
    log: (line) => logs.push(line),
  });
  return {
    protocol,
    frames,
    logs,
    /** Send one request and return the reply it produced. */
    async call(payload) {
      const before = frames.length;
      await protocol.handleLine(JSON.stringify(payload));
      assert.equal(frames.length, before + 1, "expected exactly one reply");
      return frames.at(-1);
    },
  };
}

const echoTool = {
  name: "echo",
  description: "echo",
  inputSchema: { type: "object" },
  run: async (args) => ({ text: JSON.stringify(args), metadata: { results: 1 } }),
};

const imageTool = {
  name: "image",
  description: "image",
  inputSchema: { type: "object" },
  run: async () => ({
    text: "one file",
    files: [
      { uri: "data:image/png;base64,QUJD", mime: "image/png", name: "shot.png" },
      { uri: "file:///tmp/report.pdf", mime: "application/pdf", name: "report.pdf" },
    ],
  }),
};

const failingTool = {
  name: "failing",
  description: "failing",
  inputSchema: { type: "object" },
  run: async () => {
    throw new Error("not_granted: no access");
  },
};

describe("protocol", () => {
  it("answers initialize with the requested protocol version", async () => {
    const { call } = harness([echoTool]);
    const reply = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    assert.equal(reply.result.protocolVersion, "2025-06-18");
    assert.equal(reply.result.serverInfo.name, "cilot-addon-mail");
  });

  it("lists tools with their names, descriptions and schemas", async () => {
    const { call } = harness([echoTool]);
    const reply = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(reply.result.tools, [
      { name: "echo", description: "echo", inputSchema: { type: "object" } },
    ]);
  });

  it("passes arguments through and returns text plus metadata", async () => {
    const { call } = harness([echoTool]);
    const reply = await call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { query: "receipts" } },
    });
    assert.deepEqual(reply.result.content, [{ type: "text", text: '{"query":"receipts"}' }]);
    assert.deepEqual(reply.result._meta, { metadata: { results: 1 } });
  });

  it("treats a missing arguments object as empty", async () => {
    const { call } = harness([echoTool]);
    const reply = await call({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "echo" },
    });
    assert.equal(reply.result.content[0].text, "{}");
  });

  it("turns a tool failure into an isError result, not a transport error", async () => {
    const { call, logs } = harness([failingTool]);
    const reply = await call({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "failing", arguments: {} },
    });
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result.content[0].text, "not_granted: no access");
    assert.equal(reply.error, undefined);
    assert.equal(logs.length, 1);
  });

  it("sends images as MCP image content and other files as resource links", async () => {
    const { call } = harness([imageTool]);
    const reply = await call({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "image", arguments: {} },
    });
    assert.deepEqual(reply.result.content, [
      { type: "text", text: "one file" },
      { type: "image", data: "QUJD", mimeType: "image/png" },
      {
        type: "resource_link",
        uri: "file:///tmp/report.pdf",
        mimeType: "application/pdf",
        name: "report.pdf",
      },
    ]);
  });

  it("rejects an unknown tool with a protocol error", async () => {
    const { call } = harness([echoTool]);
    const reply = await call({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "mail_send", arguments: {} },
    });
    assert.equal(reply.error.code, -32602);
  });

  it("rejects an unknown method", async () => {
    const { call } = harness([echoTool]);
    const reply = await call({ jsonrpc: "2.0", id: 8, method: "resources/list" });
    assert.equal(reply.error.code, -32601);
  });

  it("reports unparseable input and keeps serving", async () => {
    const { protocol, frames } = harness([echoTool]);
    await protocol.handleLine("{ not json");
    assert.equal(frames.at(-1).error.code, -32700);

    await protocol.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
    );
    assert.deepEqual(frames.at(-1), { jsonrpc: "2.0", id: 9, result: {} });
  });

  it("ignores notifications, including the cancel notification", async () => {
    const { protocol, frames } = harness([echoTool]);
    await protocol.handleLine(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    await protocol.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      }),
    );
    assert.equal(frames.length, 0);
  });

  it("aborts in-flight work when the transport closes", async () => {
    let signal;
    const slow = {
      name: "slow",
      description: "slow",
      inputSchema: { type: "object" },
      run: async (_args, context) => {
        signal = context.signal;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { text: "done" };
      },
    };
    const { protocol } = harness([slow]);
    const pending = protocol.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "slow" } }),
    );
    protocol.abortAll();
    await pending;
    assert.equal(signal.aborted, true);
  });
});
