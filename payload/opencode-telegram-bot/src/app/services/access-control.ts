import path from "node:path";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  clearProject,
  clearSession,
  getCurrentProject,
  getCurrentSession,
} from "../stores/settings-store.js";
import { isAccessElevated } from "./user-access-service.js";
import { resolveStandardAccess } from "./user-directory-service.js";
import {
  sharedFolderPath,
  sharedFoldersForUser,
} from "./shared-folders-service.js";
import {
  userGeneratedRoot,
  userProjectsRoot,
  userWorkspaceBase,
  userWorkspaceRoot,
} from "./workspace-paths.js";

// The policy module is the usual entry point for the workspace layout, so the paths stay
// importable from here even though they are defined in one small module of their own.
export { userGeneratedRoot, userProjectsRoot, userWorkspaceBase, userWorkspaceRoot };

// Re-exported so the policy module and the ownership data are reachable from one place.
// The policy is decided here; the ids still live in the settings store.
export {
  isSessionOwned,
  claimSession,
  releaseSession,
  getOwnedSessionIds,
  getKnownUserIds,
  withSettingsUser,
} from "../stores/settings-store.js";

/**
 * Who a Telegram account is, and what it may do.
 *
 * Three policies, decided here and nowhere else. `deny` is the default for an id that is
 * not configured, so adding a user to the bot is an explicit act rather than a side effect
 * of the bot being reachable. The model is never consulted: nothing in this file reads a
 * prompt, and no LLM output can change a decision made in it.
 *
 *   unknown id                  -> deny      no workspace, no session, no commands
 *   TELEGRAM_ADMIN_USER_IDS     -> admin     full bot, broad agent set, all workspaces
 *   TELEGRAM_ALLOWED_USER_ID(S)  -> standard  own workspace, approved agents only
 *
 * An id in both lists is admin, because the admin list is the smaller, deliberate one and
 * silently demoting an admin would be the surprising direction.
 */
export type Policy = "deny" | "standard" | "admin";

export type Capability =
  | "use_bot"
  | "own_workspace_only"
  | "cross_user_sessions"
  | "cross_user_projects"
  | "cross_user_images"
  | "admin_commands"
  | "mcp_management"
  | "agent_full";

/**
 * Capabilities per policy. Kept as data rather than scattered `if (isAdmin())` checks so
 * that the matrix in README matches the code exactly, and adding a capability forces a
 * decision for all three policies instead of defaulting to "allowed everywhere".
 */
const POLICY_CAPABILITIES: Record<Policy, ReadonlySet<Capability>> = {
  deny: new Set<Capability>(),
  standard: new Set<Capability>(["use_bot", "own_workspace_only"]),
  admin: new Set<Capability>([
    "use_bot",
    "cross_user_sessions",
    "cross_user_projects",
    "cross_user_images",
    "admin_commands",
    "mcp_management",
    "agent_full",
  ]),
};

/** Agents a standard user may select. Admin may use anything the server exposes. */
const STANDARD_AGENTS = new Set(["social-media", "postiz-social"]);

export function policyForUser(userId: number | null | undefined): Policy {
  if (userId === null || userId === undefined || !Number.isFinite(userId)) {
    return "deny";
  }
  if (config.telegram.adminUserIds.includes(userId)) {
    return "admin";
  }
  // A blocked record wins over the allowlist, which is what lets `/user` block an id that
  // was configured in `.env` without editing that file or restarting the bot.
  if (resolveStandardAccess(userId, config.telegram.allowedUserIds.includes(userId))) {
    return "standard";
  }
  return "deny";
}

export function isAuthorizedUser(userId: number | null | undefined): boolean {
  return policyForUser(userId) !== "deny";
}

export function isAdminUser(userId: number | null | undefined): boolean {
  return policyForUser(userId) === "admin";
}

/**
 * Whether the admin's full reach is switched on.
 *
 * The bot boots in the safe state: an admin is still allowed in, but sees only their own
 * workspace, the approved agent set and the ordinary chat commands. `/access on` raises it
 * to shell, filesystem, vault, server control and every project on the machine. The switch
 * does not exist for standard accounts: they are confined either way.
 */
export function isElevatedUser(userId: number | null | undefined): boolean {
  return isAdminUser(userId) && isAccessElevated();
}

/**
 * Whether this user is the first configured admin.
 *
 * The vault holds credentials for every account on the machine, so it is narrower than the
 * admin policy: one deliberate operator rather than anyone who can restart the server.
 * Position is the identity, matching how the admin list is ordered in configuration.
 */
export function isPrimaryAdmin(userId: number | null | undefined): boolean {
  if (userId === null || userId === undefined || !Number.isFinite(userId)) {
    return false;
  }
  return config.telegram.adminUserId === userId;
}

export function can(userId: number | null | undefined, capability: Capability): boolean {
  const policy = policyForUser(userId);

  if (policy === "admin") {
    // Safe default: until `/access on` is issued, an admin is an ordinary confined account
    // plus the one command that raises access again. Nothing here depends on the model, so
    // no prompt can talk its way past it.
    if (!isAccessElevated()) {
      return POLICY_CAPABILITIES.standard.has(capability);
    }
    // A confined admin is an operator inside their own folder: full agent/command/MCP power,
    // but no reach into another account's sessions, projects, or images.
    if (config.telegram.confineAdmins && capability.startsWith("cross_user_")) {
      return false;
    }
  }

  return POLICY_CAPABILITIES[policy].has(capability);
}

/** Whether this admin is limited to their own workspace, by config or by the switch. */
export function isConfinedAdmin(userId: number | null | undefined): boolean {
  return isAdminUser(userId) && (config.telegram.confineAdmins || !isAccessElevated());
}

/**
 * Whether this user may run a given OpenCode agent.
 *
 * Checked before the agent name reaches a prompt, so a standard user cannot reach `build`
 * by any path. A standard user is additionally refused anything outside the approved set
 * even if the server offers it, which is what makes the list meaningful as the server gains
 * new agents.
 */
export function canUseAgent(userId: number | null | undefined, agent: string): boolean {
  if (policyForUser(userId) === "deny") return false;
  if (can(userId, "agent_full")) return true;
  return STANDARD_AGENTS.has(agent);
}

export function assertCanUseAgent(userId: number | null | undefined, agent: string): void {
  if (canUseAgent(userId, agent)) return;
  logger.warn(
    `[Authz] Refused agent "${agent}" for userId=${userId}: not permitted for the ${policyForUser(userId)} policy`,
  );
  throw new AccessDeniedError(
    `The agent "${agent}" is not available for your account.`,
    "agent_not_permitted",
  );
}

export class AccessDeniedError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "unknown_user"
      | "cross_user_session"
      | "cross_user_project"
      | "path_not_permitted"
      | "cross_user_image"
      | "agent_not_permitted"
      | "capability_not_permitted",
  ) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

// ------------------------------------------------------------------ workspaces

/**
 * Per-account workspace root.
 *
 * Each account gets a real directory rather than a slice of a shared one, so a path that is
 * valid for one account is invalid for another by construction, and the check that enforces
 * it is a realpath comparison rather than a list lookup that can be forgotten. Admins reach
 * outside their own workspace only while `/access on` is in effect and
 * OPENCODE_TELEGRAM_CONFINE_ADMINS is off.
 */

/**
 * Roots a user may read through the bot's own file paths, and which the image tooling
 * accepts. A standard user is limited to their own workspace; an unconfined admin also gets
 * the browser roots, which are the operator's own directories.
 */
export async function allowedReadRoots(userId: number | null | undefined): Promise<string[]> {
  if (policyForUser(userId) === "deny") return [];
  const workspaceRoot = userWorkspaceRoot(userId as number);
  const sharedRoots = sharedFoldersForUser(userId).map((folder) => sharedFolderPath(folder.name));

  if (isElevatedUser(userId) && !config.telegram.confineAdmins) {
    const { getBrowserRootPaths } = await import("../services/file-browser-service.js");
    return [...getBrowserRootPaths(), workspaceRoot, ...sharedRoots];
  }
  return [workspaceRoot, ...sharedRoots];
}

/**
 * Whether a user may point the bot at a project directory.
 *
 * Enforced here rather than delegated to OpenCode: the `/project` endpoint ignores its
 * `directory` argument and answers for the whole server, so a scoped query is not available
 * and a client-side filter of a global list would leak the existence of other accounts'
 * projects through the count and the ordering. Sessions, by contrast, are scoped by
 * directory, so this is specifically about projects.
 */
export async function canUseProjectPath(
  userId: number | null | undefined,
  targetPath: string,
): Promise<boolean> {
  if (policyForUser(userId) === "deny") return false;
  if (isElevatedUser(userId) && !config.telegram.confineAdmins) return true;
  return isRealPathWithin(await allowedReadRoots(userId), targetPath);
}

/**
 * Drop a stored project or session that this account may no longer use.
 *
 * Settings survive a role change and the confinement toggle, so a project selected while an
 * account was an unconfined admin would otherwise keep `/ls`, `/open`, `/new` and prompts
 * pointed outside the new boundary. The check runs at the start of every update, before any
 * handler reads the stored values, which is the same point-of-use rule used for sessions.
 */
export async function dropUnauthorizedCurrentContext(
  userId: number | null | undefined,
): Promise<void> {
  const project = getCurrentProject();
  if (project && !(await canUseProjectPath(userId, project.worktree))) {
    logger.warn(
      `[Authz] Cleared stored project "${project.worktree}" for userId=${userId}: not permitted`,
    );
    clearProject();
    clearSession();
    return;
  }

  const session = getCurrentSession();
  if (session && !(await canUseProjectPath(userId, session.directory))) {
    logger.warn(
      `[Authz] Cleared stored session "${session.id}" for userId=${userId}: directory not permitted`,
    );
    clearSession();
  }
}

/**
 * realpath-based containment.
 *
 * A prefix comparison on the unresolved string accepts a symlink that points out of the
 * root, which is a working escape, so both sides are resolved first and compared on the
 * result. `..` cannot survive resolution either.
 */
export async function isRealPathWithin(roots: string[], targetPath: string): Promise<boolean> {
  const resolved = await resolveExisting(targetPath);
  for (const root of roots) {
    const resolvedRoot = await resolveExisting(root);
    if (!resolvedRoot || !resolved) continue;
    if (resolved === resolvedRoot) return true;
    if (resolved.startsWith(resolvedRoot + path.sep)) return true;
  }
  return false;
}

/**
 * Resolve as much of the path as exists, then re-append the remainder. A workspace the user
 * has not created yet still has to be describable, and `realpath` alone throws for it.
 */
async function resolveExisting(targetPath: string): Promise<string | null> {
  const { realpath } = await import("fs/promises");
  const absolute = path.resolve(targetPath);
  try {
    return await realpath(absolute);
  } catch {
    // Resolve the deepest existing ancestor, then rebuild the tail.
    let current = absolute;
    const tail: string[] = [];
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.unshift(path.basename(current));
      current = parent;
      try {
        const realParent = await realpath(current);
        return path.join(realParent, ...tail);
      } catch {
        continue;
      }
    }
  }
}
