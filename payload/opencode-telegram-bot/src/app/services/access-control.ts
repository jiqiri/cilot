import path from "node:path";
import os from "node:os";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

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
  if (config.telegram.allowedUserIds.includes(userId)) {
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

export function can(userId: number | null | undefined, capability: Capability): boolean {
  return POLICY_CAPABILITIES[policyForUser(userId)].has(capability);
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
 * it is a realpath comparison rather than a list lookup that can be forgotten. Admins are
 * trusted in this threat model and are not confined to their own workspace.
 */
export function userWorkspaceRoot(userId: number): string {
  const base = process.env.OPENCODE_TELEGRAM_USER_ROOT?.trim()
    ? path.resolve(process.env.OPENCODE_TELEGRAM_USER_ROOT.trim())
    : path.join(os.homedir(), ".local", "share", "opencode-telegram-server", "users");
  return path.join(base, String(userId));
}

export function userProjectsRoot(userId: number): string {
  return path.join(userWorkspaceRoot(userId), "projects");
}

export function userGeneratedRoot(userId: number): string {
  return path.join(userWorkspaceRoot(userId), "generated");
}

/**
 * Roots a user may read through the bot's own file paths, and which the image tooling
 * accepts. A standard user is limited to their own workspace; an admin also gets the
 * browser roots, which are the operator's own directories.
 */
export async function allowedReadRoots(userId: number | null | undefined): Promise<string[]> {
  if (policyForUser(userId) === "deny") return [];
  if (isAdminUser(userId)) {
    const { getBrowserRootPaths } = await import("../services/file-browser-service.js");
    return [...getBrowserRootPaths(), userWorkspaceRoot(userId as number)];
  }
  return [userWorkspaceRoot(userId as number)];
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
  if (isAdminUser(userId)) return true;
  return isRealPathWithin(await allowedReadRoots(userId), targetPath);
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
