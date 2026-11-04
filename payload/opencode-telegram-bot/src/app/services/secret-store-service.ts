import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  CorruptVaultError,
  readVaultEntries,
  VaultReadError,
  type VaultEntry,
} from "./vault-store.js";

/**
 * User-defined environment secrets for the OpenCode server.
 *
 * The vault exists so an operator can hand the agent a credential without putting the value
 * into a prompt, a config file in the repository, or a chat the model can read. The value
 * only ever leaves this module in two directions: the rendered env file that systemd hands
 * to the server process, and a masked form for the menu.
 *
 * `secrets.json` is the single source of truth. The env file is derived from it on every
 * change, so the two cannot drift, and a hand edit of the env file is overwritten rather
 * than honoured.
 */

export type SecretEntry = VaultEntry;

export interface SecretEntrySummary {
  id: string;
  label: string;
  name: string;
  maskedValue: string;
  updatedAt: string;
}

const FILE_VERSION = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_LABEL_LENGTH = 60;
const MAX_VALUE_LENGTH = 4096;
const MAX_NAME_LENGTH = 48;

export class SecretStoreError extends Error {
  constructor(
    message: string,
    readonly reason: "invalid_label" | "invalid_value" | "corrupt_store" | "io",
  ) {
    super(message);
    this.name = "SecretStoreError";
  }
}

interface SecretsDocument {
  version: number;
  entries: SecretEntry[];
}

/**
 * Derive the env var name from the operator's label.
 *
 * Vietnamese labels are expected, so diacritics are folded rather than dropped: "Khóa dịch
 * vụ mail" has to become something an agent can type, not a row of underscores. `đ` does not
 * decompose under NFD, which is why it is mapped separately.
 */
export function deriveEnvName(label: string): string {
  const folded = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");

  const slug = folded
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/_+$/g, "");

  if (!slug) {
    return "";
  }

  // A leading digit is not a legal shell identifier.
  return /^[0-9]/.test(slug) ? `SECRET_${slug}` : slug;
}

function normalizeLabel(label: string): string {
  const trimmed = label.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    throw new SecretStoreError("Secret label is empty", "invalid_label");
  }
  if (trimmed.length > MAX_LABEL_LENGTH) {
    return trimmed.slice(0, MAX_LABEL_LENGTH).trim();
  }
  return trimmed;
}

function normalizeValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new SecretStoreError("Secret value is empty", "invalid_value");
  }
  if (trimmed.length > MAX_VALUE_LENGTH) {
    throw new SecretStoreError("Secret value is too long", "invalid_value");
  }
  // A newline would end the systemd assignment early and silently create a second variable.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new SecretStoreError("Secret value contains control characters", "invalid_value");
  }
  return trimmed;
}

/** Enough of the value to tell two keys apart, never enough to use one. */
export function maskSecretValue(value: string): string {
  if (value.length <= 4) {
    return "••••";
  }
  if (value.length <= 10) {
    return `••••${value.slice(-2)}`;
  }
  return `••••••••${value.slice(-4)}`;
}

function uniqueId(label: string, taken: Set<string>): string {
  const base =
    deriveEnvName(label)
      .toLowerCase()
      .replace(/_/g, "-")
      .slice(0, 32) || "secret";

  if (!taken.has(base)) {
    return base;
  }

  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  return `${base}-${Date.now()}`;
}

function uniqueEnvName(label: string, taken: Set<string>): string {
  const base = deriveEnvName(label);
  if (!base) {
    throw new SecretStoreError("Secret label has no letters or digits", "invalid_label");
  }
  if (!taken.has(base)) {
    return base;
  }

  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  throw new SecretStoreError("No free environment variable name", "invalid_label");
}

async function ensureStoreDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
}

async function writePrivateFile(filePath: string, contents: string): Promise<void> {
  await ensureStoreDir(filePath);

  // Write then rename so a crash cannot leave a half-written store behind, and chmod
  // explicitly because rename preserves the mode of the temporary file only. The suffix
  // keeps two concurrent writes from sharing a temporary path.
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await fs.writeFile(temporary, contents, { mode: FILE_MODE });
  await fs.chmod(temporary, FILE_MODE);
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, FILE_MODE).catch(() => {});
}

async function readEntries(): Promise<SecretEntry[]> {
  try {
    return await readVaultEntries(config.vault.storeFile);
  } catch (error) {
    if (error instanceof CorruptVaultError) {
      throw new SecretStoreError(error.message, "corrupt_store");
    }
    if (error instanceof VaultReadError) {
      throw new SecretStoreError(error.message, "io");
    }
    throw error;
  }
}

/**
 * systemd EnvironmentFile syntax.
 *
 * Values are double quoted and only `\` and `"` are escaped, which is the subset of
 * systemd's C-style escapes an API key can actually contain. The label rides along as a
 * comment so an operator reading the file on the server can map names back to intent
 * without opening the store.
 */
export function renderEnvFile(entries: SecretEntry[]): string {
  const lines = [
    "# Generated by the Telegram bot vault. Do not edit: changes are overwritten.",
    "# Values are secret. Do not copy this file into a repository or a chat.",
    "",
  ];

  for (const entry of entries) {
    lines.push(`# ${entry.label}`);
    lines.push(`${entry.name}="${entry.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  }

  return `${lines.join("\n")}\n`;
}

async function persist(entries: SecretEntry[]): Promise<void> {
  const document: SecretsDocument = { version: FILE_VERSION, entries };
  await writePrivateFile(config.vault.storeFile, `${JSON.stringify(document, null, 2)}\n`);
  await writePrivateFile(config.vault.envFile, renderEnvFile(entries));
}

/** Masked view for the menu. Values are read here and never leave this module. */
export async function listSecretSummaries(): Promise<SecretEntrySummary[]> {
  const entries = await readEntries();
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    name: entry.name,
    maskedValue: maskSecretValue(entry.value),
    updatedAt: entry.updatedAt,
  }));
}

export async function getSecretSummary(id: string): Promise<SecretEntrySummary | null> {
  const entries = await readEntries();
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) {
    return null;
  }
  return {
    id: entry.id,
    label: entry.label,
    name: entry.name,
    maskedValue: maskSecretValue(entry.value),
    updatedAt: entry.updatedAt,
  };
}

export async function countSecrets(): Promise<number> {
  const entries = await readEntries();
  return entries.length;
}

export interface AddSecretInput {
  label: string;
  value: string;
}

/** Create an entry, deriving a unique env name and id from the label. */
export async function addSecret(input: AddSecretInput): Promise<SecretEntrySummary> {
  const entries = await readEntries();
  const label = normalizeLabel(input.label);
  const value = normalizeValue(input.value);

  const takenIds = new Set(entries.map((entry) => entry.id));
  const takenNames = new Set(entries.map((entry) => entry.name));
  const now = new Date().toISOString();

  const entry: SecretEntry = {
    id: uniqueId(label, takenIds),
    label,
    name: uniqueEnvName(label, takenNames),
    value,
    createdAt: now,
    updatedAt: now,
  };

  await persist([...entries, entry]);
  logger.info(`[Vault] Added secret id=${entry.id}, name=${entry.name}`);

  return {
    id: entry.id,
    label: entry.label,
    name: entry.name,
    maskedValue: maskSecretValue(entry.value),
    updatedAt: entry.updatedAt,
  };
}

/** Replace only the value; the label and the env name stay stable for existing code. */
export async function updateSecretValue(id: string, value: string): Promise<SecretEntrySummary | null> {
  const entries = await readEntries();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) {
    return null;
  }

  const existing = entries[index];
  if (!existing) {
    return null;
  }

  const updated: SecretEntry = {
    ...existing,
    value: normalizeValue(value),
    updatedAt: new Date().toISOString(),
  };
  const next = [...entries];
  next[index] = updated;

  await persist(next);
  logger.info(`[Vault] Updated secret id=${updated.id}, name=${updated.name}`);

  return {
    id: updated.id,
    label: updated.label,
    name: updated.name,
    maskedValue: maskSecretValue(updated.value),
    updatedAt: updated.updatedAt,
  };
}

export async function deleteSecret(id: string): Promise<boolean> {
  const entries = await readEntries();
  const remaining = entries.filter((entry) => entry.id !== id);
  if (remaining.length === entries.length) {
    return false;
  }

  await persist(remaining);
  logger.info(`[Vault] Deleted secret id=${id}`);
  return true;
}

/**
 * Re-render the env file from the store.
 *
 * Used when the file is missing but the store is intact, for example after the config
 * directory was restored from a backup.
 */
export async function syncEnvFile(): Promise<void> {
  const entries = await readEntries();
  await writePrivateFile(config.vault.envFile, renderEnvFile(entries));
}
