import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { userWorkspaceBase } from "./workspace-paths.js";
import type { InstalledAddon } from "./addon-manifest-service.js";

/**
 * The MCP entry and the agent permission are the two machine-level switches.
 *
 * Enabling writes both and restarts the server; disabling removes both. Everything else —
 * policy, profile, credentials — lives outside `opencode.jsonc`, so a config rewrite can
 * never lose them. The file is rewritten as plain JSON: `opencode mcp add` already normalises
 * it that way, and a JSONC parser dependency would be a new failure mode for no gain.
 */

const execFileAsync = promisify(execFile);

export class AddonRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddonRegistryError";
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove // and block comments, respecting strings. Comments are not preserved on save. */
export function stripJsonComments(raw: string): string {
  let output = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] ?? "";
    const next = raw[index + 1] ?? "";

    if (inLine) {
      if (character === "\n") {
        inLine = false;
        output += character;
      }
      continue;
    }
    if (inBlock) {
      if (character === "*" && next === "/") {
        inBlock = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      inLine = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      inBlock = true;
      index += 1;
      continue;
    }
    output += character;
  }

  return output;
}

export async function readOpencodeConfig(): Promise<JsonRecord> {
  let raw: string;
  try {
    raw = await fs.readFile(config.addons.opencodeConfig, "utf8");
  } catch (error) {
    throw new AddonRegistryError(
      `Could not read ${config.addons.opencodeConfig}: ${(error as Error).message}`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(raw));
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch (error) {
    throw new AddonRegistryError(
      `${path.basename(config.addons.opencodeConfig)} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

async function writeOpencodeConfig(document: JsonRecord): Promise<void> {
  const file = config.addons.opencodeConfig;
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function serversOf(document: JsonRecord): JsonRecord {
  const mcp = isRecord(document.mcp) ? document.mcp : {};
  const servers = isRecord(mcp.servers) ? mcp.servers : {};
  document.mcp = { ...mcp, servers };
  return servers;
}

export async function isAddonEnabled(id: string): Promise<boolean> {
  try {
    const document = await readOpencodeConfig();
    return Boolean(serversOf(document)[id]);
  } catch {
    return false;
  }
}

export async function enabledAddonIds(): Promise<Set<string>> {
  try {
    return new Set(Object.keys(serversOf(await readOpencodeConfig())));
  } catch {
    return new Set();
  }
}

function entryFor(addon: InstalledAddon): JsonRecord {
  if (!addon.manifest) throw new AddonRegistryError("The add-on manifest is invalid.");
  return {
    type: "local",
    command: [process.execPath, path.resolve(addon.root, addon.manifest.entry)],
    environment: {
      CILOT_ADDON_ID: addon.id,
      CILOT_ADDON_CONFIG_ROOT: addon.configRoot,
      CILOT_ADDON_STATE_ROOT: addon.stateRoot,
      // The add-on derives the account from its cwd; this is the root that cwd sits under.
      CILOT_USER_ROOT: userWorkspaceBase(),
    },
    // Code-mode would let the model compose calls in a runtime. Add-on tools touch private
    // data, so they are offered directly, exactly like the bot's own `telegram` server.
    codemode: false,
  };
}

export async function enableAddon(addon: InstalledAddon, agents: string[]): Promise<void> {
  const document = await readOpencodeConfig();
  const servers = serversOf(document);
  servers[addon.id] = entryFor(addon);
  await writeOpencodeConfig(document);

  for (const agent of agents) {
    await setAgentPermission(agent, addon.id, "allow");
  }

  await restartServer();
  logger.info(`[Addons] Enabled ${addon.id} for ${agents.join(", ") || "no agent"}`);
}

export async function disableAddon(addon: InstalledAddon): Promise<void> {
  const document = await readOpencodeConfig();
  const servers = serversOf(document);
  if (servers[addon.id]) {
    delete servers[addon.id];
    await writeOpencodeConfig(document);
  }

  for (const agent of await listAgentNames()) {
    await setAgentPermission(agent, addon.id, null);
  }

  await restartServer();
  logger.info(`[Addons] Disabled ${addon.id}`);
}

export async function listAgentNames(): Promise<string[]> {
  try {
    return (await fs.readdir(config.addons.agentsDir))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3));
  } catch {
    return [];
  }
}

/**
 * The agents that actually gate tools, i.e. the ones with a `permission:` block.
 *
 * Enabling an add-on widens every one of them, because a per-agent question is a step an
 * admin can answer wrongly and then see tools silently fail. An agent without a permission
 * block already accepts whatever OpenCode exposes, so there is nothing to edit.
 */
export async function listPermissionAgents(): Promise<string[]> {
  const agents = await listAgentNames();
  const gated: string[] = [];
  for (const agent of agents) {
    try {
      const raw = await fs.readFile(path.join(config.addons.agentsDir, `${agent}.md`), "utf8");
      if (/^permission:\s*$/m.test(raw)) gated.push(agent);
    } catch {
      // An unreadable agent cannot be edited; leave it out rather than fail the flow.
    }
  }
  return gated;
}

function agentFile(agent: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(agent)) {
    throw new AddonRegistryError(`Invalid agent name: ${agent}`);
  }
  return path.join(config.addons.agentsDir, `${agent}.md`);
}

/**
 * Add, replace or remove one permission line in an agent's YAML frontmatter.
 *
 * The line goes at the end of the `permission:` block. OpenCode evaluates the map in order
 * with the last match winning, so a `"<id>_*": allow` after the agent's `"*": deny` is what
 * makes the namespace callable. Deleting the line restores the deny.
 */
export async function setAgentPermission(
  agent: string,
  addonId: string,
  effect: "allow" | "ask" | null,
): Promise<boolean> {
  const file = agentFile(agent);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    logger.warn(`[Addons] Could not read agent ${agent}: ${(error as Error).message}`);
    return false;
  }

  const lines = raw.split("\n");
  const keyLine = new RegExp(`^\\s*"${addonId}_\\*":\\s*(allow|ask|deny)\\s*$`);
  const existing = lines.findIndex((line) => keyLine.test(line));

  if (effect === null) {
    if (existing < 0) return false;
    lines.splice(existing, 1);
  } else {
    const newLine = `  "${addonId}_*": ${effect}`;
    if (existing >= 0) {
      lines[existing] = newLine;
    } else {
      const permissionIndex = lines.findIndex((line) => /^permission:\s*$/.test(line));
      if (permissionIndex < 0) {
        logger.warn(`[Addons] Agent ${agent} has no permission block; not adding ${addonId}`);
        return false;
      }
      let insertAt = permissionIndex + 1;
      while (insertAt < lines.length) {
        const line = lines[insertAt] ?? "";
        if (line.startsWith("---") || (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#"))) {
          break;
        }
        insertAt += 1;
      }
      lines.splice(insertAt, 0, newLine);
    }
  }

  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, lines.join("\n"), { mode: 0o644 });
  await fs.rename(temporary, file);
  return true;
}

export async function restartServer(): Promise<void> {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR && typeof process.getuid === "function") {
    env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  }
  try {
    await execFileAsync("systemctl", ["--user", "restart", config.addons.serverUnit], {
      timeout: 20_000,
      env,
    });
    logger.info(`[Addons] Restarted ${config.addons.serverUnit}`);
  } catch (error) {
    throw new AddonRegistryError(
      `Could not restart ${config.addons.serverUnit}: ${(error as Error).message}`,
    );
  }
}
