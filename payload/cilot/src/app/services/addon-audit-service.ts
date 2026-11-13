import { promises as fs } from "node:fs";
import path from "node:path";
import type { InstalledAddon } from "./addon-manifest-service.js";

/**
 * The admin view of `audit.log`.
 *
 * One JSON object per line, written by the add-on, never by the bot. This module only reads
 * the tail; it does not parse message content because the add-on never records any.
 */

export interface AddonAuditEntry {
  ts: string;
  account: string | null;
  tool: string;
  ok: boolean;
  code: string | null;
  results: number;
  bytes: number;
}

export async function tailAudit(
  addon: InstalledAddon,
  options: { accountId?: number; limit?: number } = {},
): Promise<AddonAuditEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const file = path.join(addon.stateRoot, "audit.log");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const entries: AddonAuditEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<AddonAuditEntry>;
      if (typeof parsed.ts !== "string" || typeof parsed.tool !== "string") continue;
      if (options.accountId !== undefined && parsed.account !== String(options.accountId)) {
        continue;
      }
      entries.push({
        ts: parsed.ts,
        account: parsed.account ?? null,
        tool: parsed.tool,
        ok: parsed.ok === true,
        code: parsed.code ?? null,
        results: parsed.results ?? 0,
        bytes: parsed.bytes ?? 0,
      });
    } catch {
      // A torn final line after a crash is not worth failing the screen for.
    }
  }
  return entries.slice(-limit);
}
