import { promises as fs } from "node:fs";
import path from "node:path";
import { addonConfigRoot } from "./addon-manifest-service.js";
import { logger } from "../../utils/logger.js";

/**
 * `policy.json` is the single authorization record, and the add-on re-reads it on every call.
 *
 * The bot writes it atomically and never keeps a second copy. Revocation is therefore
 * immediate for authorization; deleting the profile and restarting the server are what make
 * it immediate for credentials (§7.3).
 */

export type AddonGrant = "off" | "use";
export type AddonPolicyDefault = "admin-only" | "all-users";

interface PolicyRow {
  grant?: AddonGrant;
  updatedAt?: string;
}

export interface AddonPolicy {
  version: number;
  default: AddonPolicyDefault;
  users: Record<string, PolicyRow>;
}

const EMPTY: AddonPolicy = { version: 1, default: "admin-only", users: {} };

function policyPath(id: string): string {
  return path.join(addonConfigRoot(id), "policy.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizePolicy(raw: unknown): AddonPolicy {
  if (!isRecord(raw)) return { ...EMPTY, users: {} };
  const users: Record<string, PolicyRow> = {};
  if (isRecord(raw.users)) {
    for (const [id, row] of Object.entries(raw.users)) {
      if (!isRecord(row)) continue;
      users[id] = {
        grant: row.grant === "use" ? "use" : "off",
        ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
      };
    }
  }
  return {
    version: typeof raw.version === "number" ? raw.version : 1,
    default: raw.default === "all-users" ? "all-users" : "admin-only",
    users,
  };
}

export async function readAddonPolicy(id: string): Promise<AddonPolicy> {
  let raw: string;
  try {
    raw = await fs.readFile(policyPath(id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...EMPTY, users: {} };
    }
    logger.warn(`[Addons] Could not read policy for ${id}: ${(error as Error).message}`);
    return { ...EMPTY, users: {} };
  }

  try {
    return normalizePolicy(JSON.parse(raw));
  } catch {
    logger.warn(`[Addons] policy.json for ${id} is not valid JSON; every account is off`);
    return { ...EMPTY, users: {} };
  }
}

export async function writeAddonPolicy(id: string, policy: AddonPolicy): Promise<void> {
  const directory = addonConfigRoot(id);
  const file = policyPath(id);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

export function grantOf(policy: AddonPolicy, userId: number): AddonGrant {
  const row = policy.users[String(userId)];
  if (row) return row.grant === "use" ? "use" : "off";
  return policy.default === "all-users" ? "use" : "off";
}

export async function getGrant(id: string, userId: number): Promise<AddonGrant> {
  return grantOf(await readAddonPolicy(id), userId);
}

export async function setGrant(
  id: string,
  userId: number,
  grant: AddonGrant,
): Promise<AddonPolicy> {
  const policy = await readAddonPolicy(id);
  if (grant === "off") {
    delete policy.users[String(userId)];
  } else {
    policy.users[String(userId)] = {
      grant: "use",
      updatedAt: new Date().toISOString(),
    };
  }
  await writeAddonPolicy(id, policy);
  return policy;
}

export async function setDefaultPolicy(
  id: string,
  value: AddonPolicyDefault,
): Promise<AddonPolicy> {
  const policy = await readAddonPolicy(id);
  policy.default = value;
  await writeAddonPolicy(id, policy);
  return policy;
}

export function grantedIds(policy: AddonPolicy): number[] {
  return Object.entries(policy.users)
    .filter(([, row]) => row.grant === "use")
    .map(([id]) => Number(id))
    .filter((id) => Number.isFinite(id));
}

/** Every id with a row or a profile directory, so an admin can see a half-configured account. */
export async function configuredAccountIds(id: string): Promise<number[]> {
  const policy = await readAddonPolicy(id);
  const ids = new Set<number>(Object.keys(policy.users).map(Number));
  try {
    const entries = await fs.readdir(path.join(addonConfigRoot(id), "users"), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d+$/.test(entry.name)) ids.add(Number(entry.name));
    }
  } catch {
    // No users directory yet.
  }
  return [...ids].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
}

export function policyPathFor(id: string): string {
  return policyPath(id);
}
