import { promises as fs } from "node:fs";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

/**
 * Whether standard accounts may use the bot right now.
 *
 * This is a bot-level switch, not a server-level one. A standard account is always confined
 * to its own workspace by policy: no shell, no cross-account projects, sessions or images.
 * What this flag adds is an operator kill switch: turn it off and every standard account is
 * denied at the auth middleware, while the admin keeps full access.
 *
 * The value lives in a small file next to settings.json rather than in settings.json itself
 * because it is machine policy, not a per-account preference: it must be readable before any
 * account is resolved, and it must not be editable through the per-user settings path.
 *
 * The default is `true`, so an upgrade never locks out accounts that were working.
 */

const FILE_NAME = "user-access.json";

let enabled = true;

export function userAccessFilePath(): string {
  return path.join(getRuntimePaths().appHome, FILE_NAME);
}

export function isUserAccessEnabled(): boolean {
  return enabled;
}

/** Reads the persisted value; called once at startup before polling begins. */
export async function restoreUserAccess(): Promise<void> {
  const filePath = userAccessFilePath();

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    enabled = !(parsed && typeof parsed === "object" && (parsed as { enabled?: unknown }).enabled === false);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // No file yet: keep the default.
      return;
    }
    logger.warn("[UserAccess] Could not read the access switch; keeping the current value", error);
  }
}

export async function setUserAccessEnabled(next: boolean): Promise<void> {
  enabled = next;

  const filePath = userAccessFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ enabled: next, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  // `mode` only applies on creation, so tighten an existing file as well.
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}
