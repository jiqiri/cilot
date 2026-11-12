import { promises as fs } from "node:fs";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";
import { opencodeClient } from "../../opencode/client.js";
import { removeUserSettings } from "../stores/settings-store.js";
import { revokeUserFromAllShares } from "./shared-folders-service.js";
import { userWorkspaceRoot } from "./workspace-paths.js";

/**
 * Who may use the bot, as an operator-managed list.
 *
 * The environment (`TELEGRAM_ALLOWED_USER_ID(S)`) stays the base allowlist: it is the one
 * thing an operator can set without the bot running, and it survives a lost state file.
 * This module adds three things on top of it:
 *
 * - **active**  the id may use the bot inside its own workspace.
 * - **blocked** the id is refused at the auth middleware, and its workspace, settings and
 *               images are kept. Blocking is reversible and is the normal "stop using the
 *               bot" action.
 * - **delete**  the same refusal, after wiping the workspace, the settings slice, the
 *               generated images, the owned sessions and any shared-folder grant.
 *
 * A record only ever overrides the environment, never adds an admin: the admin list is read
 * from configuration, so a state file cannot promote anyone.
 *
 * Records live in `users.json` next to settings.json (mode 600) so a change applies on the
 * next update without a restart. Deleting from `.env` would have required a restart and a
 * rewrite of a file the installer also owns.
 */

export type UserRecordStatus = "active" | "blocked";

export interface UserRecord {
  id: number;
  status: UserRecordStatus;
  updatedAt: string;
}

const FILE_NAME = "users.json";

let records = new Map<number, UserRecord>();

export function userDirectoryFilePath(): string {
  return path.join(getRuntimePaths().appHome, FILE_NAME);
}

export function listUserRecords(): UserRecord[] {
  return [...records.values()].sort((left, right) => left.id - right.id);
}

export function getUserRecord(userId: number): UserRecord | undefined {
  return records.get(userId);
}

export function isUserBlocked(userId: number): boolean {
  return records.get(userId)?.status === "blocked";
}

/**
 * Whether a standard account is allowed right now.
 *
 * A record wins over the environment allowlist in both directions: blocking an id that was
 * listed in `.env` works without editing that file, and allowing an id that was never listed
 * works without a restart. Admins are decided before this is consulted, so a record can never
 * demote or promote one.
 */
export function resolveStandardAccess(userId: number, allowedByEnvironment: boolean): boolean {
  const record = records.get(userId);
  if (record) {
    return record.status === "active";
  }
  return allowedByEnvironment;
}

export async function restoreUserDirectory(): Promise<void> {
  const filePath = userDirectoryFilePath();

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const users = (parsed as { users?: unknown } | null)?.users;
    if (!Array.isArray(users)) {
      logger.warn("[UserDirectory] Ignoring a users.json without a users array");
      return;
    }

    const next = new Map<number, UserRecord>();
    for (const entry of users) {
      if (!entry || typeof entry !== "object") continue;
      const id = Number((entry as { id?: unknown }).id);
      const status = (entry as { status?: unknown }).status;
      if (!Number.isFinite(id) || id <= 0) continue;
      if (status !== "active" && status !== "blocked") continue;
      next.set(id, {
        id,
        status,
        updatedAt: String((entry as { updatedAt?: unknown }).updatedAt ?? ""),
      });
    }
    records = next;
    logger.info(`[UserDirectory] Loaded ${records.size} user record(s)`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    logger.warn("[UserDirectory] Could not read users.json; keeping the current list", error);
  }
}

async function persist(): Promise<void> {
  const filePath = userDirectoryFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ users: listUserRecords() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function setStatus(userId: number, status: UserRecordStatus): Promise<UserRecord> {
  const record: UserRecord = { id: userId, status, updatedAt: new Date().toISOString() };
  records.set(userId, record);
  await persist();
  return record;
}

/** Allow an id, which also lifts an earlier block. */
export async function allowUser(userId: number): Promise<UserRecord> {
  return setStatus(userId, "active");
}

/** Refuse an id, keeping every file it owns on disk. */
export async function blockUser(userId: number): Promise<UserRecord> {
  return setStatus(userId, "blocked");
}

export interface UserDeletionReport {
  workspaceRemoved: boolean;
  settingsRemoved: boolean;
  imagesDeleted: number;
  sessionsDeleted: number;
  sharesRevoked: number;
}

/**
 * Block an id and destroy everything the bot stored for it.
 *
 * Order matters: the settings slice is read for the session and image lists before it is
 * removed, and the workspace is deleted last so a failure part way through leaves the
 * account blocked rather than half-deleted but still usable.
 */
export async function deleteUser(userId: number): Promise<UserDeletionReport> {
  const settings = await removeUserSettings(userId);

  let sessionsDeleted = 0;
  for (const sessionId of settings.ownedSessionIds) {
    try {
      await opencodeClient.session.delete({ sessionID: sessionId });
      sessionsDeleted += 1;
    } catch (error) {
      logger.warn(`[UserDirectory] Could not delete session ${sessionId} for userId=${userId}`, error);
    }
  }

  let imagesDeleted = 0;
  for (const imagePath of settings.generatedImages) {
    try {
      await fs.rm(imagePath, { force: true });
      imagesDeleted += 1;
    } catch (error) {
      logger.warn(`[UserDirectory] Could not delete image ${imagePath} for userId=${userId}`, error);
    }
  }

  const sharesRevoked = await revokeUserFromAllShares(userId);

  let workspaceRemoved = false;
  try {
    await fs.rm(userWorkspaceRoot(userId), { recursive: true, force: true });
    workspaceRemoved = true;
  } catch (error) {
    logger.error(`[UserDirectory] Could not remove workspace for userId=${userId}`, error);
  }

  await setStatus(userId, "blocked");

  return {
    workspaceRemoved,
    settingsRemoved: settings.settingsRemoved,
    imagesDeleted,
    sessionsDeleted,
    sharesRevoked,
  };
}
