import os from "node:os";
import path from "node:path";

/**
 * Where the vault keeps its files.
 *
 * Deliberately free of any import from `config.ts`: the MCP server that hands credentials to
 * tools runs as a separate process, started by OpenCode rather than by the bot, and it must
 * be able to resolve the store without a Telegram token in its environment. Only the two
 * paths live here; the semantics stay in `secret-store-service.ts`.
 *
 * The default sits in the config directory the bot already uses for `.env` and `server.env`,
 * which is outside the repository so a secret is never one `git add -A` away from a commit.
 */
export interface VaultPaths {
  storeFile: string;
  envFile: string;
}

export function resolveVaultPaths(): VaultPaths {
  const dir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "opencode-telegram-bot",
  );

  return {
    storeFile: process.env.SECRETS_FILE?.trim() || path.join(dir, "secrets.json"),
    envFile: process.env.SECRETS_ENV_FILE?.trim() || path.join(dir, "secrets.env"),
  };
}
