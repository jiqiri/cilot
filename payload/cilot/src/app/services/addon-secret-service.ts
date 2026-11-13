import { promises as fs } from "node:fs";
import path from "node:path";
import type { InstalledAddon } from "./addon-manifest-service.js";
import { AddonConfigError } from "./addon-config-service.js";

/**
 * Per-profile credentials, in the env file the add-on reads after it resolves the account.
 *
 * Values are never returned to the bot UI, never logged, and never put in the MCP process
 * environment: OpenCode's `environment` block is shared by every workspace, so a credential
 * there would hand every account the same one. The file is written atomically with mode 600
 * and parsed literally on the other side.
 */

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_VALUE_LENGTH = 4096;

export interface SecretStatus {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  set: boolean;
}

export interface SecretsDocument {
  [key: string]: string;
}

export function secretsPath(addon: InstalledAddon, accountId: number | null): string {
  if (addon.manifest?.scope === "global") {
    return path.join(addon.configRoot, "secrets.env");
  }
  if (accountId === null) throw new AddonConfigError(null, "a per-user secret needs an account");
  return path.join(addon.configRoot, "users", String(accountId), "secrets.env");
}

export function parseSecrets(raw: string): SecretsDocument {
  const values: SecretsDocument = {};
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) throw new AddonConfigError(null, `line ${index + 1} has no KEY=value pair`);
    const key = line.slice(0, equals).trim();
    if (!KEY_PATTERN.test(key)) {
      throw new AddonConfigError(null, `line ${index + 1} has an invalid key`);
    }
    values[key] = line.slice(equals + 1);
  }
  return values;
}

export async function readSecrets(
  addon: InstalledAddon,
  accountId: number | null,
): Promise<SecretsDocument> {
  try {
    return parseSecrets(await fs.readFile(secretsPath(addon, accountId), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function validateValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AddonConfigError(null, "the value is empty");
  if (trimmed.length > MAX_VALUE_LENGTH) throw new AddonConfigError(null, "the value is too long");
  // The file is line-oriented; a newline would silently create a second variable.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new AddonConfigError(null, "the value contains a control character");
  }
  return trimmed;
}

export async function writeSecrets(
  addon: InstalledAddon,
  accountId: number | null,
  secrets: SecretsDocument,
): Promise<void> {
  const file = secretsPath(addon, accountId);
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  const body = Object.entries(secrets)
    .filter(([key]) => KEY_PATTERN.test(key))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await fs.writeFile(temporary, body ? `${body}\n` : "", { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function setSecret(
  addon: InstalledAddon,
  accountId: number | null,
  key: string,
  value: string,
): Promise<void> {
  const declared = addon.manifest?.secrets ?? [];
  if (!declared.some((entry) => entry.key === key)) {
    throw new AddonConfigError(null, `${key} is not a secret this add-on declares`);
  }
  const secrets = await readSecrets(addon, accountId);
  secrets[key] = validateValue(value);
  await writeSecrets(addon, accountId, secrets);
}

export async function deleteSecret(
  addon: InstalledAddon,
  accountId: number | null,
  key: string,
): Promise<void> {
  const secrets = await readSecrets(addon, accountId);
  if (key in secrets) {
    delete secrets[key];
    await writeSecrets(addon, accountId, secrets);
  }
}

/** `set` or `not set` only. A value never leaves this module through the UI. */
export async function secretStatus(
  addon: InstalledAddon,
  accountId: number | null,
): Promise<SecretStatus[]> {
  const values = await readSecrets(addon, accountId).catch((): SecretsDocument => ({}));
  return (addon.manifest?.secrets ?? []).map((entry) => ({
    key: entry.key,
    label: entry.label ?? entry.key,
    required: entry.required !== false,
    secret: entry.secret !== false,
    set: Boolean(values[entry.key]),
  }));
}

export async function allRequiredSecretsSet(
  addon: InstalledAddon,
  accountId: number | null,
): Promise<boolean> {
  const status = await secretStatus(addon, accountId);
  return status.filter((entry) => entry.required).every((entry) => entry.set);
}

export function missingRequiredKeys(status: SecretStatus[]): string[] {
  return status.filter((entry) => entry.required && !entry.set).map((entry) => entry.key);
}
