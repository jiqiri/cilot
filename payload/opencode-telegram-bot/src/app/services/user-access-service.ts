import { promises as fs } from "node:fs";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

/**
 * Whether the operator has elevated the bot above its safe default.
 *
 * The default is `false`: with the switch off, every account — the admin included — is
 * confined to its own workspace, has no shell through the agent set, and cannot reach the
 * rest of the machine. That is the safe state to sit in, and it is what a restart returns
 * to when the file is missing.
 *
 * Turning it on restores the admin's full reach: shell-capable agents, filesystem browsing,
 * the vault, server control, and every project and session on the machine. Standard accounts
 * do not change: they stay inside `users/<telegram id>/projects` either way, and whether they
 * may use the bot at all is decided by the user directory, not by this switch.
 *
 * `/access` is always available to the first admin, even while the switch is off. That is the
 * way back in from chat: raising access must not require shell access to the machine, or a
 * bad state would need a console to undo.
 *
 * The value lives in a small file next to settings.json rather than in settings.json itself
 * because it is machine policy, not a per-account preference: it must be readable before any
 * account is resolved, and it must not be editable through the per-user settings path.
 *
 * The field is `elevated`, not the `enabled` written by the earlier kill-switch design. A
 * file from that design is deliberately ignored: reading it as `elevated` would silently
 * keep an old install in the less safe state.
 */

const FILE_NAME = "user-access.json";

let elevated = false;

export function userAccessFilePath(): string {
  return path.join(getRuntimePaths().appHome, FILE_NAME);
}

export function isAccessElevated(): boolean {
  return elevated;
}

/** Reads the persisted value; called once at startup before polling begins. */
export async function restoreAccessElevation(): Promise<void> {
  const filePath = userAccessFilePath();

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    elevated =
      Boolean(parsed) && typeof parsed === "object" && (parsed as { elevated?: unknown }).elevated === true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // No file yet: the documented default is the safe state, not whatever happened to be
      // in memory.
      elevated = false;
      return;
    }
    logger.warn("[UserAccess] Could not read the access switch; keeping the current value", error);
  }
}

export async function setAccessElevated(next: boolean): Promise<void> {
  elevated = next;

  const filePath = userAccessFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ elevated: next, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  // `mode` only applies on creation, so tighten an existing file as well.
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}
