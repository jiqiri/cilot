import { describe, expect, it } from "vitest";
import {
  BUILT_IN_COMMAND_NAMES,
  getLocalizedBotCommands,
  isCommandAllowedForPolicy,
} from "../src/bot/commands/definitions.js";

/**
 * `/model` is the only way to reach the model picker from a client that has collapsed the
 * reply keyboard, so it is not an admin tool: every account picks its own model and the
 * choice is stored in that account's slice. These assertions pin both halves — that a
 * restricted account is allowed to use it, and that it is published to Telegram at all.
 */
describe("/model command", () => {
  it("is available to a standard account", () => {
    expect(isCommandAllowedForPolicy("model", false)).toBe(true);
  });

  it("is available to an admin", () => {
    expect(isCommandAllowedForPolicy("model", true)).toBe(true);
  });

  it("is a built-in command, so it is not mistaken for a local one", () => {
    expect(BUILT_IN_COMMAND_NAMES).toContain("model");
  });

  it("is published in the command menu for both policies, with a description", () => {
    for (const options of [{ adminOnly: false }, { adminOnly: true }]) {
      const entry = getLocalizedBotCommands(options).find((c) => c.command === "model");
      expect(entry).toBeDefined();
      expect(entry?.description.length).toBeGreaterThan(0);
    }
  });

  it("does not publish admin-only commands to a standard account", () => {
    const commands = getLocalizedBotCommands().map((c) => c.command);
    for (const adminOnly of ["ls", "mcps", "open", "worktree", "opencode_start"]) {
      expect(commands).not.toContain(adminOnly);
    }
  });
});
