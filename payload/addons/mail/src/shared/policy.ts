import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { log } from "./errors.js";

/**
 * policy.json is the only authorization record.
 *
 * It is re-read on every call, so revoking a grant needs no restart to take effect, and an
 * operator editing the file by hand sees the change immediately. A malformed file fails
 * closed: every account is `off`, and the parse error is reported rather than guessed at.
 */

export type Grant = "off" | "use";
export type PolicyDefault = "admin-only" | "all-users";

export interface PolicyUser {
  grant?: Grant;
  updatedAt?: string;
}

export interface Policy {
  version: number;
  default: PolicyDefault;
  users: Record<string, PolicyUser>;
}

const EMPTY: Policy = { version: 1, default: "admin-only", users: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPolicy(configRoot: string): Policy {
  const file = path.join(configRoot, "policy.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...EMPTY, users: {} };
    }
    log(`could not read policy.json: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    return { ...EMPTY, users: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log("policy.json is not valid JSON; every account is off");
    return { ...EMPTY, users: {} };
  }
  if (!isRecord(parsed)) {
    log("policy.json is not an object; every account is off");
    return { ...EMPTY, users: {} };
  }

  const users: Record<string, PolicyUser> = {};
  if (isRecord(parsed.users)) {
    for (const [id, row] of Object.entries(parsed.users)) {
      if (!isRecord(row)) continue;
      const grant = row.grant === "use" ? "use" : "off";
      users[id] = {
        grant,
        ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
      };
    }
  }

  const policyDefault: PolicyDefault =
    parsed.default === "all-users" ? "all-users" : "admin-only";

  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    default: policyDefault,
    users,
  };
}

export function grantFor(policy: Policy, accountId: string | null): Grant {
  if (accountId === null) {
    // A global add-on has no per-account grant. Reaching this is a manifest bug, not a user
    // action, so deny rather than assume.
    return "off";
  }
  const row = policy.users[accountId];
  if (row) {
    return row.grant === "use" ? "use" : "off";
  }
  return policy.default === "all-users" ? "use" : "off";
}

export function requireGrant(configRoot: string, accountId: string | null): Grant {
  const granted = grantFor(readPolicy(configRoot), accountId);
  if (granted !== "use") {
    fail(
      "not_granted",
      "This account has no access to the mail add-on. An admin can grant it in /addons.",
    );
  }
  return granted;
}
