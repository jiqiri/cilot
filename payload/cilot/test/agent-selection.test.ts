import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

/**
 * The agent picker and the selection callback must agree. A standard account used to see
 * Build in the picker and only learn it was forbidden after tapping it.
 */
const STANDARD = 111_111_111;

let selectableAgentsForUser: typeof import("../src/app/services/agent-selection-service.js").selectableAgentsForUser;

beforeAll(async () => {
  process.env.CILOT_HOME = path.join(os.tmpdir(), "cilot-agent-selection-test");
  process.env.TELEGRAM_BOT_TOKEN = "test:token";
  process.env.TELEGRAM_ALLOWED_USER_ID = String(STANDARD);
  process.env.OPENCODE_MODEL_PROVIDER = "opencode";
  process.env.OPENCODE_MODEL_ID = "test-model";
  process.env.BOT_LOCALE = "en";

  ({ selectableAgentsForUser } =
    await import("../src/app/services/agent-selection-service.js"));
});

function agent(
  name: string,
  mode: "primary" | "subagent" | "all" = "primary",
  hidden = false,
) {
  return { name, mode, hidden };
}

describe("agent picker policy", () => {
  it("does not offer Build to a standard account", () => {
    const names = selectableAgentsForUser(
      [
        agent("build"),
        agent("plan"),
        agent("social-media"),
        agent("postiz-social"),
      ],
      STANDARD,
    ).map((entry) => entry.name);

    expect(names).toEqual(["social-media", "postiz-social"]);
  });

  it("still hides subagents and hidden agents", () => {
    const names = selectableAgentsForUser(
      [
        agent("social-media"),
        agent("explore", "subagent"),
        agent("build", "primary", true),
      ],
      STANDARD,
    ).map((entry) => entry.name);

    expect(names).toEqual(["social-media"]);
  });
});
