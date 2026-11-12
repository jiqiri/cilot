import path from "node:path";
import os from "node:os";

/**
 * Where per-account data lives on disk.
 *
 * Kept in its own module so the policy module and the user directory can both reach it
 * without importing each other, and so there is exactly one place that spells the default:
 * the directory decides who an account is, the policy decides what it may do, and both need
 * to name the same workspace.
 *
 * The default is `~/.local/share/tg-workspaces/users`, not a name containing
 * `cilot-server`: that string is also a systemd unit, so a path built from it
 * reads like a service name and is long enough to be mistaken for the app home. This is data,
 * separate from the install directory, and the shorter name says so.
 */

const DEFAULT_ROOT_SEGMENTS = [".local", "share", "tg-workspaces", "users"] as const;

export function userWorkspaceBase(): string {
  return process.env.CILOT_USER_ROOT?.trim()
    ? path.resolve(process.env.CILOT_USER_ROOT.trim())
    : path.join(os.homedir(), ...DEFAULT_ROOT_SEGMENTS);
}

export function userWorkspaceRoot(userId: number): string {
  return path.join(userWorkspaceBase(), String(userId));
}

export function userProjectsRoot(userId: number): string {
  return path.join(userWorkspaceRoot(userId), "projects");
}

export function userGeneratedRoot(userId: number): string {
  return path.join(userWorkspaceRoot(userId), "generated");
}
