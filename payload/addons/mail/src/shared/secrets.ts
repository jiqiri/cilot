import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";

/**
 * The per-profile credential file.
 *
 * Values are read literally after the first `=`; there is no shell, no expansion and no
 * quoting rule. That is deliberate: `$` in a password must stay a `$`, and a file that the
 * bot writes must mean exactly one thing. The file is read once per tool call, which keeps
 * the "revoke and restart" window bounded without a long-lived secret in memory.
 */

export type Secrets = Record<string, string>;

const KEY = /^[A-Z][A-Z0-9_]*$/;

export function secretsPath(
  configRoot: string,
  scope: "global" | "per-user",
  accountId: string | null,
): string {
  if (scope === "global") {
    return path.join(configRoot, "secrets.env");
  }
  if (!accountId) {
    fail("unknown_account", "A per-user credential file needs an account.");
  }
  return path.join(configRoot, "users", accountId, "secrets.env");
}

export function parseSecrets(raw: string): Secrets {
  const values: Secrets = {};
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) {
      throw new Error(`line ${index + 1} has no KEY=value pair`);
    }
    const key = line.slice(0, equals).trim();
    if (!KEY.test(key)) {
      throw new Error(`line ${index + 1} has an invalid key`);
    }
    values[key] = line.slice(equals + 1);
  }
  return values;
}

export function loadSecrets(
  configRoot: string,
  scope: "global" | "per-user",
  accountId: string | null,
): Secrets {
  const file = secretsPath(configRoot, scope, accountId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fail("not_configured", "This mailbox has no credentials yet. An admin must add them in /addons.");
    }
    fail("upstream_error", "The credential file could not be read.");
  }

  try {
    return parseSecrets(raw);
  } catch {
    fail("invalid_config", "The credential file could not be parsed. An admin must rewrite it in /addons.");
  }
}

export function requireSecret(secrets: Secrets, key: string): string {
  const value = secrets[key];
  if (!value) {
    fail(
      "missing_secret",
      `${key} is not set for this mailbox. An admin must add it in /addons.`,
    );
  }
  return value;
}

export function haveAllRequired(secrets: Secrets, keys: string[]): boolean {
  return keys.every((key) => Boolean(secrets[key]));
}
