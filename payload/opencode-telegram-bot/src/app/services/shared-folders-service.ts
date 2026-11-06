import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

/**
 * Folders shared between accounts.
 *
 * A shared folder is a real directory under a single shared root, granted to a list of
 * Telegram ids. It only exists because the primary admin made it: there is no discovery and
 * no default, so a standard account can never see another account's files unless the
 * operator deliberately put them in the same folder.
 *
 * The grant list is data, not a filesystem permission, because the bot runs as one Linux
 * user. Authorization is re-checked on every path use (`allowedReadRoots`), the same way the
 * per-account workspace is, rather than being trusted from a menu selection.
 */

export interface SharedFolder {
  name: string;
  userIds: number[];
}

const FILE_NAME = "shared-folders.json";
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

let folders: SharedFolder[] = [];

export function isValidSharedFolderName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

function userRootBase(): string {
  return process.env.OPENCODE_TELEGRAM_USER_ROOT?.trim()
    ? path.resolve(process.env.OPENCODE_TELEGRAM_USER_ROOT.trim())
    : path.join(os.homedir(), ".local", "share", "opencode-telegram-server", "users");
}

/** Sibling of the per-account root, so shared files are visibly a separate area. */
export function sharedRoot(): string {
  return path.join(path.dirname(userRootBase()), "shared");
}

export function sharedFolderPath(name: string): string {
  return path.join(sharedRoot(), name);
}

export function sharedFoldersFilePath(): string {
  return path.join(getRuntimePaths().appHome, FILE_NAME);
}

export function listSharedFolders(): SharedFolder[] {
  return folders.map((folder) => ({ name: folder.name, userIds: [...folder.userIds] }));
}

export function sharedFoldersForUser(userId: number | null | undefined): SharedFolder[] {
  if (userId === null || userId === undefined || !Number.isFinite(userId)) return [];
  return listSharedFolders().filter((folder) => folder.userIds.includes(userId));
}

export function restoreSharedFolders(): Promise<void> {
  return (async () => {
    try {
      const raw = await fs.readFile(sharedFoldersFilePath(), "utf8");
      const parsed: unknown = JSON.parse(raw);
      const entries =
        parsed && typeof parsed === "object" && Array.isArray((parsed as { folders?: unknown }).folders)
          ? (parsed as { folders: unknown[] }).folders
          : [];

      folders = entries.flatMap((entry): SharedFolder[] => {
        if (!entry || typeof entry !== "object") return [];
        const { name, userIds } = entry as { name?: unknown; userIds?: unknown };
        if (typeof name !== "string" || !isValidSharedFolderName(name)) return [];
        if (!Array.isArray(userIds)) return [];
        const ids = userIds.filter(
          (id): id is number => typeof id === "number" && Number.isFinite(id),
        );
        return ids.length > 0 ? [{ name, userIds: [...new Set(ids)] }] : [];
      });
      logger.info(`[Shares] Loaded ${folders.length} shared folder(s)`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn("[Shares] Could not read shared folders; starting with none", error);
      }
      folders = [];
    }
  })();
}

async function persist(): Promise<void> {
  const filePath = sharedFoldersFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ folders }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

/** Adds a folder or extends its grants. The directory is created on demand. */
export async function grantSharedFolder(name: string, userIds: number[]): Promise<SharedFolder> {
  if (!isValidSharedFolderName(name)) {
    throw new Error("invalid_shared_folder_name");
  }
  const ids = [...new Set(userIds.filter((id) => Number.isFinite(id)))];
  if (ids.length === 0) {
    throw new Error("invalid_shared_folder_users");
  }

  const existing = folders.find((folder) => folder.name === name);
  if (existing) {
    existing.userIds = [...new Set([...existing.userIds, ...ids])].sort((a, b) => a - b);
  } else {
    folders.push({ name, userIds: ids.sort((a, b) => a - b) });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));

  await fs.mkdir(sharedFolderPath(name), { recursive: true, mode: 0o700 });
  await persist();
  return { name, userIds: [...(folders.find((folder) => folder.name === name)?.userIds ?? ids)] };
}

export async function revokeSharedFolderGrants(name: string, userIds: number[]): Promise<void> {
  const folder = folders.find((entry) => entry.name === name);
  if (!folder) return;

  const remove = new Set(userIds);
  folder.userIds = folder.userIds.filter((id) => !remove.has(id));
  if (folder.userIds.length === 0) {
    folders = folders.filter((entry) => entry.name !== name);
  }
  await persist();
}

/**
 * Remove one id from every grant, returning how many folders changed.
 *
 * Deleting a user must not leave a grant that points at an id nothing owns any more; the
 * folders themselves stay, because other accounts may still be in them.
 */
export async function revokeUserFromAllShares(userId: number): Promise<number> {
  let changed = 0;

  for (const folder of folders) {
    if (!folder.userIds.includes(userId)) continue;
    folder.userIds = folder.userIds.filter((id) => id !== userId);
    changed += 1;
  }

  if (changed === 0) return 0;

  folders = folders.filter((folder) => folder.userIds.length > 0);
  await persist();
  return changed;
}

/** Removes the grant entry. The directory is left alone so a typo cannot delete data. */
export async function deleteSharedFolder(name: string): Promise<boolean> {
  const before = folders.length;
  folders = folders.filter((folder) => folder.name !== name);
  if (folders.length === before) return false;
  await persist();
  return true;
}

/** Test hook: replace the in-memory list without touching the disk. */
export function setSharedFoldersForTests(next: SharedFolder[]): void {
  folders = next.map((folder) => ({ name: folder.name, userIds: [...folder.userIds] }));
}
