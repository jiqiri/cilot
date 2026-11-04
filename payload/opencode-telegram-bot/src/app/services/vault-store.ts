import { promises as fs } from "node:fs";

/**
 * Reading the vault store, without the bot's configuration.
 *
 * Two very different processes need the same file: the Telegram bot, which writes it, and
 * the local MCP server, which starts with OpenCode and hands a credential to a tool. The
 * MCP server has no Telegram token and must not load `config.ts`, so the file format and the
 * corrupt-store refusal live here, where both can reach them.
 *
 * Nothing here logs a value, and `readVaultValue` exists for the credential lookup the MCP
 * server performs: the value goes to the tool that needs it, never to a prompt.
 */

export interface VaultEntry {
  id: string;
  /** Operator-facing name, free text and usually Vietnamese. Never sent to OpenCode. */
  label: string;
  /** Uppercase env var name derived from the label. This is what the agent can see. */
  name: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

/** Raised instead of returning an empty list, which a later write would persist. */
export class CorruptVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptVaultError";
  }
}

export class VaultReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultReadError";
  }
}

interface VaultDocument {
  version: number;
  entries: VaultEntry[];
}

export async function readVaultEntries(storeFile: string): Promise<VaultEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(storeFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new VaultReadError(`Could not read the secret store: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptVaultError("The secret store is not valid JSON");
  }

  const document = parsed as Partial<VaultDocument>;
  if (!document || typeof document !== "object" || !Array.isArray(document.entries)) {
    throw new CorruptVaultError("The secret store has no entries array");
  }

  const entries: VaultEntry[] = [];
  for (const candidate of document.entries) {
    const entry = candidate as Partial<VaultEntry>;
    if (
      typeof entry.id === "string" &&
      typeof entry.label === "string" &&
      typeof entry.name === "string" &&
      typeof entry.value === "string"
    ) {
      entries.push({
        id: entry.id,
        label: entry.label,
        name: entry.name,
        value: entry.value,
        createdAt: entry.createdAt ?? new Date(0).toISOString(),
        updatedAt: entry.updatedAt ?? new Date(0).toISOString(),
      });
    }
  }

  return entries;
}

/**
 * Look one env var up by name.
 *
 * An unreadable store is reported rather than ignored: a tool failing with "not configured"
 * while the operator believes a secret is stored is the kind of silence that gets debugged
 * for an hour.
 */
export async function readVaultValue(storeFile: string, name: string): Promise<string | undefined> {
  const entries = await readVaultEntries(storeFile);
  return entries.find((entry) => entry.name === name)?.value;
}
