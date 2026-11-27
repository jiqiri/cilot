import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

/**
 * V2 tool parts carry no title, and an older adapter filled that gap with the tool name.
 * The formatter then printed the name twice ("read read", "shell shell"). These tests pin
 * the adapter output and the formatter fallback so the duplicate cannot come back.
 */
let formatToolInfo: typeof import("../src/app/formatters/summary-formatter.js").formatToolInfo;
let V2EventNormalizer: typeof import("../src/opencode/v2/event-normalizer.js").V2EventNormalizer;
let setShowToolDetails: typeof import("../src/app/stores/settings-store.js").setShowToolDetails;

const DIRECTORY = "/work/project";

beforeAll(async () => {
  process.env.CILOT_HOME = path.join(os.tmpdir(), "cilot-tool-display-test");
  process.env.TELEGRAM_BOT_TOKEN = "test:token";
  process.env.TELEGRAM_ALLOWED_USER_ID = "111111111";
  process.env.OPENCODE_MODEL_PROVIDER = "opencode";
  process.env.OPENCODE_MODEL_ID = "test-model";
  process.env.BOT_LOCALE = "en";

  ({ formatToolInfo } =
    await import("../src/app/formatters/summary-formatter.js"));
  ({ V2EventNormalizer } =
    await import("../src/opencode/v2/event-normalizer.js"));
  ({ setShowToolDetails } =
    await import("../src/app/stores/settings-store.js"));
});

function calledPart(name: string, input: Record<string, unknown>) {
  const normalizer = new V2EventNormalizer(DIRECTORY);
  const events = normalizer.normalize({
    type: "session.tool.called",
    location: { directory: DIRECTORY },
    data: {
      sessionID: "ses_test",
      assistantMessageID: "msg_test",
      id: `call_${name}`,
      name,
      input,
    },
  });

  const part = events[0]?.properties.part as
    | {
        tool: string;
        state: { input?: Record<string, unknown>; title?: string };
      }
    | undefined;
  expect(part).toBeDefined();
  return part!;
}

describe("V2 tool display", () => {
  it("does not invent a title from the tool name", () => {
    const part = calledPart("read", { path: "src/index.ts" });
    expect(part.state.title).toBeUndefined();
  });

  it("shows the file path instead of repeating the tool name", () => {
    const part = calledPart("read", { path: "src/index.ts" });
    const line = formatToolInfo({
      sessionId: "ses_test",
      messageId: "msg_test",
      callId: "call_read",
      tool: part.tool,
      state: { status: "running" },
      input: part.state.input,
      title: part.state.title,
    });

    expect(line).toBe("📖 read src/index.ts");
  });

  it("recognises the V2 shell tool and shows its command", () => {
    const part = calledPart("shell", {
      command: "git status",
      timeout: 300000,
    });
    const line = formatToolInfo({
      sessionId: "ses_test",
      messageId: "msg_test",
      callId: "call_shell",
      tool: part.tool,
      state: { status: "running" },
      input: part.state.input,
      title: part.state.title,
    });

    expect(line).toBe("💻 shell git status");
  });

  it("ignores a title that is just the tool name", () => {
    const line = formatToolInfo({
      sessionId: "ses_test",
      messageId: "msg_test",
      callId: "call_write",
      tool: "write",
      state: { status: "running" },
      input: { path: "src/a.ts", content: "one\ntwo" },
      title: "write",
    });

    expect(line).toBe("✍️ write src/a.ts (+2)");
  });

  it("shows only the tool name when details are hidden", () => {
    setShowToolDetails(false);
    try {
      const line = formatToolInfo({
        sessionId: "ses_test",
        messageId: "msg_test",
        callId: "call_shell",
        tool: "shell",
        state: { status: "running" },
        input: { command: "cd /home/ubuntu/very/long/path && npm test" },
      });

      expect(line).toBe("💻 shell");
    } finally {
      setShowToolDetails(true);
    }
  });
});
