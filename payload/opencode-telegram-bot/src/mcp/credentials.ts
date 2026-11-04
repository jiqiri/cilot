import { resolveVaultPaths } from "../app/services/vault-paths.js";
import { readVaultValue } from "../app/services/vault-store.js";
import { mcpLog } from "./log.js";

/**
 * Credential lookup for the local MCP tools.
 *
 * A tool needs the value; the model must not. The lookup order is deliberate:
 *
 *   1. the process environment, because the OpenCode unit already loads the files an
 *      installer wrote and an operator expects those to keep working;
 *   2. the vault store, so a key added from Telegram's /vault menu is usable without
 *      editing a unit file or restarting anything.
 *
 * Failures never include a value: the messages name the variable, and an unreadable store
 * is reported as such instead of being mistaken for "not configured".
 */

export async function resolveCredential(name: string): Promise<string | undefined> {
  const fromEnvironment = process.env[name]?.trim();
  if (fromEnvironment) {
    return fromEnvironment;
  }

  const { storeFile } = resolveVaultPaths();
  try {
    const value = await readVaultValue(storeFile, name);
    return value?.trim() || undefined;
  } catch (error) {
    mcpLog.warn(`Could not read the vault store for ${name}: ${(error as Error).message}`);
    throw new Error(
      `Could not read the vault store (${storeFile}): ${(error as Error).message}. ` +
        "Fix the file, or set the variable in the OpenCode service environment.",
    );
  }
}

/**
 * Resolve a credential a tool cannot run without.
 *
 * `hint` tells the operator where to put the value, which differs per tool: a provider key
 * belongs in /vault, while the server address belongs in the unit file.
 */
export async function requireCredential(name: string, hint: string): Promise<string> {
  const value = await resolveCredential(name);
  if (!value) {
    throw new Error(`${name} is not set. ${hint}`);
  }
  return value;
}
