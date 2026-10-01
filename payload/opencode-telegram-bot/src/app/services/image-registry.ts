import path from "node:path";
import os from "node:os";
import { readdirSync } from "node:fs";
import { logger } from "../../utils/logger.js";
import { can, isAdminUser, withSettingsUser, userGeneratedRoot } from "./access-control.js";
import {
  getGeneratedImages,
  recordGeneratedImageForUser,
} from "../stores/settings-store.js";

/**
 * Who owns which generated image.
 *
 * The image tool writes into a shared directory under a model-chosen filename, so the
 * filename is not an authorization token: knowing it was the whole of the access control.
 * Ownership is recorded when the bot observes the tool result and re-checked on every path
 * that reads or sends a file, so a path that arrives from the model, from a callback, or
 * from a tool argument is all treated the same.
 *
 * Recorded per account rather than in a global map, so the record is as isolated as the rest
 * of the per-account state. An admin may read across accounts, which is an explicit grant
 * rather than a consequence of guessing a filename.
 */
/**
 * Whether a path lies in the shared generated-images directory.
 *
 * The image tool writes there under a model-chosen filename, so this is the one place a file
 * produced for one account can be reached by another. Used to decide when the ownership
 * check applies, rather than applying the image rules to every file the bot sends.
 */
export function isInGeneratedImagesDirectory(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  const dataHome =
    process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  const roots = [
    process.env.OPENCODE_IMAGE_DIR?.trim(),
    path.join(dataHome, "opencode-generated-images"),
    // A per-account generated directory, when the operator has pointed one at this account.
    ...knownUserGeneratedRoots(),
  ].filter((entry): entry is string => Boolean(entry));
  return roots.some((root) => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  });
}

/** Per-account generated roots, for the accounts that have one on disk. */
function knownUserGeneratedRoots(): string[] {
  const base = process.env.OPENCODE_TELEGRAM_USER_ROOT?.trim();
  if (!base) return [];
  try {
    return readdirSync(path.resolve(base), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => userGeneratedRoot(Number(entry.name)))
      .filter((dir) => Number.isFinite(path.basename(dir)));
  } catch {
    return [];
  }
}

export function recordGeneratedImage(userId: number | undefined, localPath: string): void {
  if (!userId) return;
  withSettingsUser(userId, () => recordGeneratedImageForUser(userId, localPath));
}

/**
 * Whether an account may read or send a generated file.
 *
 * Deny unless the file is recorded as theirs, or they are an admin with the cross-user
 * capability. An unrecorded file is refused even for the account that appears to be working
 * in it, because "no record" is exactly the state a file is in when it belongs to somebody
 * else.
 */
export function canAccessGeneratedImage(
  userId: number | undefined,
  candidate: string,
): boolean {
  if (!userId) return false;
  if (isAdminUser(userId) && can(userId, "cross_user_images")) return true;

  const resolved = path.resolve(candidate);
  const owned = withSettingsUser(userId, () => getGeneratedImages());
  return owned.some((entry) => {
    const recorded = path.resolve(entry);
    return recorded === resolved || entry === candidate;
  });
}

/**
 * The check every image send or read goes through.
 *
 * Throws rather than returning a boolean so a caller cannot forget to act on it: the send
 * path is the last place before a file leaves the machine, and a false that is ignored is
 * the same as no check.
 */
export function assertGeneratedImageAccessible(userId: number | undefined, candidate: string): void {
  if (canAccessGeneratedImage(userId, candidate)) return;
  logger.warn(`[Authz] Refused image access for userId=${userId}: ${candidate}`);
  throw new Error("That file is not one of yours, so it cannot be sent or uploaded.");
}
