import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail } from "./errors.js";

/**
 * The account is the process's working directory, never a tool argument.
 *
 * OpenCode starts one MCP server per workspace (spike S0, ADDONS.md §5.1), and the model
 * cannot change another process's cwd. So the first path segment under CILOT_USER_ROOT is
 * the Telegram id, and a shared folder or the operator's own directory names no account and
 * is refused rather than guessed.
 */

export interface Account {
  /** `null` only for a `global` add-on, which has one profile and does not care who called. */
  id: string | null;
}

const DIGITS = /^\d+$/;

function defaultUserRoot(): string {
  return path.join(os.homedir(), ".local", "share", "tg-workspaces", "users");
}

export function resolveAccount(scope: "global" | "per-user", cwd = process.cwd()): Account {
  if (scope === "global") {
    return { id: null };
  }

  const root = path.resolve(process.env.CILOT_USER_ROOT?.trim() || defaultUserRoot());

  let realCwd: string;
  let realRoot: string;
  try {
    realCwd = fs.realpathSync(cwd);
    realRoot = fs.realpathSync(root);
  } catch {
    fail("unknown_account", "The workspace directory could not be resolved.");
  }

  const relative = path.relative(realRoot, realCwd);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(
      "unknown_account",
      "This session is not running inside a personal workspace, so the mail add-on cannot tell which account it is serving. Switch to your own workspace in /projects.",
    );
  }

  const first = relative.split(path.sep)[0] ?? "";
  if (!DIGITS.test(first)) {
    fail(
      "unknown_account",
      "This session is not running inside a personal workspace, so the mail add-on cannot tell which account it is serving. Switch to your own workspace in /projects.",
    );
  }

  return { id: first };
}
