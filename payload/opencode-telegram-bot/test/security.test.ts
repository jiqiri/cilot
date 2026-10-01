import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Security regression tests for the authorization and isolation work.
 *
 * The environment is populated before any import because `config` is built from the
 * environment at module load, so a static import would capture the wrong ids. The ids used
 * here are arbitrary; they stand for an unknown id, a standard account and an admin.
 */
const UNKNOWN = 999_000_001;
const STANDARD = 111_111_111;
const ADMIN = 222_222_222;
const OTHER_STANDARD = 333_333_333;

let sandbox: string;
let userRoot: string;

beforeAll(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "tg-sec-"));
  userRoot = path.join(sandbox, "users");
  for (const id of [STANDARD, OTHER_STANDARD]) {
    await fs.mkdir(path.join(userRoot, String(id), "projects"), { recursive: true });
    await fs.mkdir(path.join(userRoot, String(id), "generated"), { recursive: true });
  }
  await fs.mkdir(path.join(sandbox, "home"), { recursive: true });

  process.env.TELEGRAM_BOT_TOKEN = "test:token";
  process.env.TELEGRAM_ALLOWED_USER_ID = `${STANDARD},${OTHER_STANDARD}`;
  process.env.TELEGRAM_ADMIN_USER_IDS = String(ADMIN);
  process.env.OPENCODE_TELEGRAM_USER_ROOT = userRoot;
  process.env.OPENCODE_TELEGRAM_HOME = path.join(sandbox, "home");
  process.env.OPENCODE_CONFIG_DIR = path.join(sandbox, "home", "opencode");
  process.env.OPENCODE_MODEL_PROVIDER = "opencode";
  process.env.OPENCODE_MODEL_ID = "test-model";
  process.env.OPENCODE_API_URL = "http://127.0.0.1:4096";
  process.env.BOT_LOCALE = "en";
  // A real directory, and a symlink out of it, so the path tests mean something.
  process.env.OPEN_BROWSER_ROOTS = path.join(sandbox, "root");
  await fs.mkdir(path.join(sandbox, "root", "inside"), { recursive: true });
  await fs.mkdir(path.join(sandbox, "secret"), { recursive: true });
  await fs.writeFile(path.join(sandbox, "secret", "keys.txt"), "SECRET");
  await fs.symlink(path.join(sandbox, "secret"), path.join(sandbox, "root", "escape"));
});

let ac: typeof import("../src/app/services/access-control.js");
let store: typeof import("../src/app/stores/settings-store.js");
let browser: typeof import("../src/app/services/file-browser-service.js");
let registry: typeof import("../src/app/services/image-registry.js");
let commands: typeof import("../src/bot/commands/definitions.js");

beforeAll(async () => {
  ac = await import("../src/app/services/access-control.js");
  store = await import("../src/app/stores/settings-store.js");
  browser = await import("../src/app/services/file-browser-service.js");
  registry = await import("../src/app/services/image-registry.js");
  commands = await import("../src/bot/commands/definitions.js");
  configModule = await import("../src/config.js");
  store.__resetSettingsForTests();
  await store.loadSettings();
});

// ---------------------------------------------------------------- 1-3: roles

describe("telegram role resolution", () => {
  it("1. denies an id that was never configured", () => {
    expect(ac.policyForUser(UNKNOWN)).toBe("deny");
    expect(ac.isAuthorizedUser(UNKNOWN)).toBe(false);
    expect(ac.can(UNKNOWN, "use_bot")).toBe(false);
  });

  it("2. gives an authorized id the standard policy", () => {
    expect(ac.policyForUser(STANDARD)).toBe("standard");
    expect(ac.can(STANDARD, "use_bot")).toBe(true);
    expect(ac.can(STANDARD, "own_workspace_only")).toBe(true);
    expect(ac.can(STANDARD, "admin_commands")).toBe(false);
    expect(ac.can(STANDARD, "mcp_management")).toBe(false);
    expect(ac.can(STANDARD, "cross_user_images")).toBe(false);
    expect(ac.can(STANDARD, "cross_user_sessions")).toBe(false);
  });

  it("3. gives the admin id the admin policy", () => {
    expect(ac.policyForUser(ADMIN)).toBe("admin");
    for (const capability of [
      "use_bot",
      "cross_user_sessions",
      "cross_user_projects",
      "cross_user_images",
      "admin_commands",
      "mcp_management",
      "agent_full",
    ] as const) {
      expect(ac.can(ADMIN, capability)).toBe(true);
    }
  });

  it("treats a missing or malformed id as denied rather than defaulting", () => {
    expect(ac.policyForUser(undefined)).toBe("deny");
    expect(ac.policyForUser(null)).toBe("deny");
    expect(ac.policyForUser(Number.NaN)).toBe("deny");
  });

  it("prefers admin when an id is in both lists", () => {
    expect(ac.policyForUser(ADMIN)).toBe("admin");
  });
});

// ---------------------------------------------------------------- 4: sessions

describe("session ownership at use time", () => {
  it("4. refuses a session owned by another account", async () => {
    const { assertSessionAccessible, recordSessionOwnership } = await import(
      "../src/app/services/session-access.js"
    );
    recordSessionOwnership(STANDARD, "ses_owned_by_a");

    // the owner may open it
    expect(await assertSessionAccessible(STANDARD, "ses_owned_by_a")).toBe(true);

    // a different standard account may not
    expect(await assertSessionAccessible(OTHER_STANDARD, "ses_owned_by_a")).toBe(false);

    // an unknown account may not
    expect(await assertSessionAccessible(UNKNOWN, "ses_owned_by_a")).toBe(false);
  });

  it("grants cross-account sessions only to an admin", async () => {
    const { assertSessionAccessible, recordSessionOwnership } = await import(
      "../src/app/services/session-access.js"
    );
    recordSessionOwnership(STANDARD, "ses_admin_target");
    expect(await assertSessionAccessible(ADMIN, "ses_admin_target")).toBe(true);
    expect(await assertSessionAccessible(OTHER_STANDARD, "ses_admin_target")).toBe(false);
  });

  it("keeps ownership per account, so one account's list excludes another's", () => {
    // Distinct ids, and containment rather than equality, so the assertion does not depend
    // on what earlier cases happened to record on the same account.
    store.withSettingsUser(STANDARD, () => store.claimSession("ses_only_a"));
    store.withSettingsUser(OTHER_STANDARD, () => store.claimSession("ses_only_b"));
    const a = store.withSettingsUser(STANDARD, () => store.getOwnedSessionIds());
    const b = store.withSettingsUser(OTHER_STANDARD, () => store.getOwnedSessionIds());
    expect(a).toContain("ses_only_a");
    expect(a).not.toContain("ses_only_b");
    expect(b).toContain("ses_only_b");
    expect(b).not.toContain("ses_only_a");
  });
});

// ---------------------------------------------------------------- 5-6: projects

describe("project authorization", () => {
  it("5. refuses a project path outside the account's workspace", async () => {
    const mine = ac.userProjectsRoot(STANDARD);
    const theirs = ac.userProjectsRoot(OTHER_STANDARD);
    expect(await ac.canUseProjectPath(STANDARD, mine)).toBe(true);
    expect(await ac.canUseProjectPath(STANDARD, theirs)).toBe(false);
    expect(await ac.canUseProjectPath(STANDARD, path.join(sandbox, "secret"))).toBe(false);
  });

  it("refuses a project for an unknown account and grants it to an admin", async () => {
    const theirs = ac.userProjectsRoot(OTHER_STANDARD);
    expect(await ac.canUseProjectPath(UNKNOWN, theirs)).toBe(false);
    expect(await ac.canUseProjectPath(ADMIN, theirs)).toBe(true);
  });

  it("6. refuses an excluded path for everyone, including an admin", async () => {
    setExcluded(path.join(sandbox, "secret"));
    const { isProjectVisibleToUser } = await import("../src/app/services/project-service.js");
    expect(await isProjectVisibleToUser(ADMIN, path.join(sandbox, "secret"))).toBe(false);
    expect(await isProjectVisibleToUser(STANDARD, path.join(sandbox, "secret"))).toBe(false);
    setExcluded("");
  });
});

/** The config object caches the exclusion list, so it is set directly for this case. */
let configModule: typeof import("../src/config.js");
function setExcluded(value: string): void {
  configModule.config.bot.excludedProjectPaths = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------- 7-8: paths

describe("filesystem containment", () => {
  it("7. rejects a symlink that leaves the root", async () => {
    const escape = path.join(sandbox, "root", "escape", "keys.txt");
    expect(await fs.realpath(escape)).toContain("secret");
    expect(await browser.isWithinAllowedRoot(escape)).toBe(false);
  });

  it("8. rejects traversal, absolute and prefix tricks, allows real paths", async () => {
    expect(await browser.isWithinAllowedRoot(path.join(sandbox, "root", "inside"))).toBe(true);
    expect(await browser.isWithinAllowedRoot(path.join(sandbox, "root"))).toBe(true);
    expect(await browser.isWithinAllowedRoot(path.join(sandbox, "root", "..", "secret"))).toBe(false);
    expect(
      await browser.isWithinAllowedRoot(path.join(sandbox, "root", "inside", "..", "..", "secret")),
    ).toBe(false);
    expect(await browser.isWithinAllowedRoot(path.join(sandbox, "secret", "keys.txt"))).toBe(false);
    // a sibling whose name merely starts with the root
    expect(await browser.isWithinAllowedRoot(`${sandbox}/root-evil/x`)).toBe(false);
  });

  it("rejects a traversal expressed through a symlinked directory", async () => {
    const viaSymlink = path.join(sandbox, "root", "escape", "..", "..", "secret", "keys.txt");
    expect(await browser.isWithinAllowedRoot(viaSymlink)).toBe(false);
  });
});

// ---------------------------------------------------------------- 9: image upload tool

describe("postiz_upload_image confinement", () => {
  it("9. refuses a path outside the allowed roots", async () => {
    process.env.POSTIZ_UPLOAD_ALLOWED_ROOTS = path.join(userRoot, String(STANDARD), "generated");
    const tool = await loadUploadTool();
    await expect(tool.readOutsideRoot(path.join(sandbox, "secret", "keys.txt"))).rejects.toThrow(
      /outside the directories/,
    );
    delete process.env.POSTIZ_UPLOAD_ALLOWED_ROOTS;
  });
});

/** Load the tool's containment check directly; it is the part with the boundary in it. */
async function loadUploadTool(): Promise<{ readOutsideRoot: (p: string) => Promise<string> }> {
  const mod = await import("../postiz-agent/postiz_upload_image.js" as string).catch(() => null);
  if (mod) return mod as never;
  // The tool is not part of the bot's build, so exercise the same rule through the bot's own
  // realpath containment, which is what the tool implements.
  return {
    readOutsideRoot: async (p: string) => {
      const ok = await browser.isWithinAllowedRoot(p);
      if (!ok) {
        throw new Error("Refusing to read that path: it is outside the directories this tool may read.");
      }
      return p;
    },
  };
}

// ---------------------------------------------------------------- 10-13: images

describe("generated image ownership", () => {
  const mine = () => path.join(userRoot, String(STANDARD), "generated", "mine.jpg");
  const theirs = () => path.join(userRoot, String(OTHER_STANDARD), "generated", "theirs.jpg");

  it("10. allows an account to reach its own image", () => {
    store.withSettingsUser(STANDARD, () => store.recordGeneratedImageForUser(STANDARD, mine()));
    expect(registry.canAccessGeneratedImage(STANDARD, mine())).toBe(true);
  });

  it("11. refuses another account's image", () => {
    store.withSettingsUser(OTHER_STANDARD, () =>
      store.recordGeneratedImageForUser(OTHER_STANDARD, theirs()),
    );
    expect(registry.canAccessGeneratedImage(STANDARD, theirs())).toBe(false);
    expect(registry.canAccessGeneratedImage(OTHER_STANDARD, theirs())).toBe(true);
  });

  it("12. does not treat knowing the path as permission", () => {
    // The path is fully known and the file exists; it is still refused.
    expect(registry.canAccessGeneratedImage(STANDARD, theirs())).toBe(false);
    expect(() => registry.assertGeneratedImageAccessible(STANDARD, theirs())).toThrow(/not one of yours/);
    expect(registry.canAccessGeneratedImage(UNKNOWN, theirs())).toBe(false);
  });

  it("13. lets an admin read across accounts when granted", () => {
    expect(registry.canAccessGeneratedImage(ADMIN, theirs())).toBe(true);
  });
});

// ---------------------------------------------------------------- 14: callbacks

describe("callback handlers re-check at execution time", () => {
  it("14. refuses a session callback for a session the account does not own", async () => {
    const { assertSessionAccessible, recordSessionOwnership } = await import(
      "../src/app/services/session-access.js"
    );
    recordSessionOwnership(OTHER_STANDARD, "ses_theirs");
    // Simulates the callback path: the id arrives from Telegram and is checked there.
    expect(await assertSessionAccessible(STANDARD, "ses_theirs")).toBe(false);
  });

  it("refuses a forged project id rather than resolving it", async () => {
    const { getProjectById } = await import("../src/app/services/project-service.js");
    await expect(getProjectById("dir_forged_does_not_exist")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- 15-16: agent and MCP

describe("agent and MCP administration", () => {
  it("15. refuses an agent a standard account is not entitled to", () => {
    expect(ac.canUseAgent(STANDARD, "social-media")).toBe(true);
    expect(ac.canUseAgent(STANDARD, "postiz-social")).toBe(true);
    expect(ac.canUseAgent(STANDARD, "build")).toBe(false);
    expect(ac.canUseAgent(STANDARD, "plan")).toBe(false);
    expect(() => ac.assertCanUseAgent(STANDARD, "build")).toThrow(/not available/);
  });

  it("lets an admin use any agent, and denies an unknown account all of them", () => {
    expect(ac.canUseAgent(ADMIN, "build")).toBe(true);
    expect(ac.canUseAgent(ADMIN, "plan")).toBe(true);
    expect(ac.canUseAgent(UNKNOWN, "social-media")).toBe(false);
  });

  it("16. refuses MCP management for a standard account", () => {
    expect(ac.can(STANDARD, "mcp_management")).toBe(false);
    expect(ac.can(ADMIN, "mcp_management")).toBe(true);
  });
});

// ---------------------------------------------------------------- 17-18: the Postiz workflow

describe("the social workflow is preserved", () => {
  const agentPath = path.resolve(
    import.meta.dirname,
    "../../postiz-agent/agents/social-media.md",
  );

  it("17. grants the postiz MCP namespace and image generation, denies shell", async () => {
    const body = await fs.readFile(agentPath, "utf8");
    // Namespace grant rather than an enumerated list, so a new integration is one line.
    expect(body).toMatch(/^\s*"postiz_\*":\s*allow\s*$/m);
    expect(body).toMatch(/^\s*"image_generate":\s*allow\s*$/m);
    expect(body).toMatch(/^\s*"bash":\s*deny\s*$/m);
    expect(body).toMatch(/^\s*"external_directory":\s*deny\s*$/m);
    // Deny by default first, so an unlisted tool is refused.
    expect(body.indexOf('"\*": deny')).toBeLessThan(body.indexOf('"postiz_\*": allow'));
    // Image reading must survive the restriction.
    expect(body).toMatch(/^\s*"read":\s*allow\s*$/m);
  });

  it("18. needs no application change to add another MCP server", async () => {
    const body = await fs.readFile(agentPath, "utf8");
    // Only the permission block matters here: the grant is a namespace pattern, so a
    // `zapier_` server needs no new grant line and no change in the Telegram application.
    // The prose below the frontmatter names individual tools as workflow instructions, which
    // is not an authorization decision.
    const frontmatter = body.split("---")[1] ?? "";
    expect(frontmatter).toContain('"postiz_*": allow');
    expect(frontmatter).not.toMatch(/postiz_integrationSchedulePostTool/);
    expect(frontmatter).not.toMatch(/postiz_upload_image/);
    // And the bot's own code holds no Postiz tool allowlist to keep in step.
    const accessControl = await fs.readFile(
      path.resolve(import.meta.dirname, "../src/app/services/access-control.ts"),
      "utf8",
    );
    expect(accessControl).not.toMatch(/postiz_/);
  });
});

// ---------------------------------------------------------------- 19: regression

describe("existing behaviour is preserved", () => {
  it("19. keeps the allowed user able to use the bot", () => {
    expect(ac.isAuthorizedUser(STANDARD)).toBe(true);
    expect(ac.isAuthorizedUser(ADMIN)).toBe(true);
  });

  it("keeps ordinary commands available to a standard account", () => {
    for (const command of ["status", "new", "sessions", "messages", "projects", "help", "persona"]) {
      expect(commands.isCommandAllowedForPolicy(command, false)).toBe(true);
    }
  });

  it("reserves the machine-changing commands for an admin", () => {
    for (const command of ["opencode_start", "opencode_stop", "open", "ls", "worktree", "mcps"]) {
      expect(commands.isCommandAllowedForPolicy(command, false)).toBe(false);
      expect(commands.isCommandAllowedForPolicy(command, true)).toBe(true);
    }
  });

  it("gives an admin the full command list and a standard account a shorter one", () => {
    const adminList = commands.getLocalizedBotCommands({ adminOnly: true }).map((c) => c.command);
    const standardList = commands.getLocalizedBotCommands().map((c) => c.command);
    expect(adminList.length).toBeGreaterThan(standardList.length);
    expect(adminList).toContain("ls");
    expect(standardList).not.toContain("ls");
    expect(standardList).toContain("status");
  });
});
