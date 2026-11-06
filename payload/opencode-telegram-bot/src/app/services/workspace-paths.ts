import path from "node:path";
import os from "node:os";

/**
 * Where per-account data lives on disk.
 *
 * Kept in its own module so the policy module and the user directory can both reach it
 * without importing each other: the directory decides who an account is, the policy decides
 * what it may do, and both need to name the same workspace.
 */

export function userWorkspaceBase(): string {
  return process.env.OPENCODE_TELEGRAM_USER_ROOT?.trim()
    ? path.resolve(process.env.OPENCODE_TELEGRAM_USER_ROOT.trim())
    : path.join(os.homedir(), ".local", "share", "opencode-telegram-server", "users");
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
