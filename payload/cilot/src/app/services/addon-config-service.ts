import { promises as fs } from "node:fs";
import path from "node:path";
import {
  addonConfigRoot,
  type AddonConfigField,
  type AddonManifest,
  type InstalledAddon,
} from "./addon-manifest-service.js";
import { logger } from "../../utils/logger.js";

/**
 * One profile per account, seeded from `default-config.json` and validated against the
 * manifest on every read and every save.
 *
 * Unknown keys survive a save: a newer add-on may own them, and an older bot dropping them
 * would quietly destroy configuration. A bad value is refused rather than clamped, because
 * clamping is how a limit silently becomes something the admin did not choose.
 */

export type AddonProfile = Record<string, unknown>;

export class AddonConfigError extends Error {
  constructor(
    readonly field: string | null,
    readonly reason: string,
  ) {
    super(field ? `${field}: ${reason}` : reason);
    this.name = "AddonConfigError";
  }
}

export function profilePath(addon: InstalledAddon, accountId: number): string {
  return path.join(addon.configRoot, "users", String(accountId), "config.json");
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function defaultProfile(addon: InstalledAddon): Promise<AddonProfile> {
  let seeds: AddonProfile = {};
  try {
    const parsed = await readJson(path.join(addon.root, "default-config.json"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      seeds = parsed as AddonProfile;
    }
  } catch {
    seeds = {};
  }

  const profile: AddonProfile = {};
  for (const [key, field] of Object.entries(addon.manifest?.config ?? {})) {
    profile[key] = seeds[key] !== undefined ? seeds[key] : field.default;
  }
  for (const [key, value] of Object.entries(seeds)) {
    if (!(key in profile)) profile[key] = value;
  }
  return profile;
}

export async function readProfile(
  addon: InstalledAddon,
  accountId: number,
): Promise<{ profile: AddonProfile; exists: boolean }> {
  const defaults = await defaultProfile(addon);
  const file = profilePath(addon, accountId);

  let saved: AddonProfile = {};
  let exists = false;
  try {
    const parsed = await readJson(file);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      saved = parsed as AddonProfile;
      exists = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AddonConfigError(null, "config.json is not valid JSON");
    }
  }

  const merged: AddonProfile = { ...defaults, ...saved };
  validateProfile(addon.manifest, merged);
  return { profile: merged, exists };
}

export function validateProfile(manifest: AddonManifest | null, profile: AddonProfile): void {
  for (const [key, field] of Object.entries(manifest?.config ?? {})) {
    const value = profile[key];
    if (value === undefined) {
      if (field.type === "string" && field.required) {
        throw new AddonConfigError(key, "is required");
      }
      continue;
    }
    switch (field.type) {
      case "string":
        if (typeof value !== "string") throw new AddonConfigError(key, "must be a string");
        break;
      case "boolean":
        if (typeof value !== "boolean") throw new AddonConfigError(key, "must be true or false");
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new AddonConfigError(key, "must be a number");
        }
        if (field.min !== undefined && value < field.min) {
          throw new AddonConfigError(key, `must be at least ${field.min}`);
        }
        if (field.max !== undefined && value > field.max) {
          throw new AddonConfigError(key, `must be at most ${field.max}`);
        }
        break;
      case "enum":
        if (typeof value !== "string" || !field.values.includes(value)) {
          throw new AddonConfigError(key, `must be one of: ${field.values.join(", ")}`);
        }
        break;
      case "string[]":
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
          throw new AddonConfigError(key, "must be a list of strings");
        }
        break;
    }
  }

}

/**
 * Switching to labels mode without naming a label would read nothing while looking
 * configured. The save path refuses it; the read path must not, because the install seed is
 * exactly that state and an admin has to be able to open it to fix it.
 */
function refuseLabelsModeWithoutLabels(manifest: AddonManifest | null, profile: AddonProfile): void {
  if (manifest?.id !== "mail" || profile.mode !== "labels") return;
  const labels = Array.isArray(profile.labels) ? profile.labels : [];
  if (labels.length === 0) {
    throw new AddonConfigError("labels", "labels mode needs at least one label");
  }
}

export async function writeProfile(
  addon: InstalledAddon,
  accountId: number,
  profile: AddonProfile,
): Promise<AddonProfile> {
  refuseLabelsModeWithoutLabels(addon.manifest, profile);
  validateProfile(addon.manifest, profile);

  const file = profilePath(addon, accountId);
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.tmp`;

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  try {
    await fs.copyFile(file, `${file}.bak`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`[Addons] Could not back up ${file}: ${(error as Error).message}`);
    }
  }

  await fs.writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);

  // Re-read: the file on disk, not the object in memory, is what the add-on will load.
  const { profile: saved } = await readProfile(addon, accountId);
  return saved;
}

export async function setProfileField(
  addon: InstalledAddon,
  accountId: number,
  field: string,
  value: unknown,
): Promise<AddonProfile> {
  const { profile } = await readProfile(addon, accountId);
  profile[field] = value;
  return writeProfile(addon, accountId, profile);
}

/** Create `users/<id>/` when a grant is issued, so "grant then configure" has a target. */
export async function ensureAccountProfile(
  addon: InstalledAddon,
  accountId: number,
): Promise<void> {
  const file = profilePath(addon, accountId);
  try {
    await fs.access(file);
    return;
  } catch {
    // Not created yet.
  }
  const defaults = await defaultProfile(addon);
  // The seed may be intentionally invalid (labels mode, no labels); that is what the add-on
  // reports as not_configured until an admin names the scope.
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(temporary, `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function removeAccountProfile(
  addon: InstalledAddon,
  accountId: number,
): Promise<void> {
  await fs.rm(path.join(addon.configRoot, "users", String(accountId)), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(addon.stateRoot, "users", String(accountId)), {
    recursive: true,
    force: true,
  });
}

export function parseFieldInput(field: AddonConfigField, text: string): unknown {
  const trimmed = text.trim();
  switch (field.type) {
    case "string":
      return trimmed;
    case "number": {
      const value = Number(trimmed);
      if (!trimmed || !Number.isFinite(value)) {
        throw new AddonConfigError(null, "not a number");
      }
      if (field.min !== undefined && value < field.min) {
        throw new AddonConfigError(null, `must be at least ${field.min}`);
      }
      if (field.max !== undefined && value > field.max) {
        throw new AddonConfigError(null, `must be at most ${field.max}`);
      }
      return value;
    }
    case "string[]": {
      if (/[\r\n]/.test(text)) {
        throw new AddonConfigError(null, "must be one line, separated by commas");
      }
      const values = trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      return [...new Set(values)];
    }
    case "boolean":
      throw new AddonConfigError(null, "use the buttons for this field");
    case "enum":
      throw new AddonConfigError(null, "use the buttons for this field");
  }
}

export function summarizeProfile(
  manifest: AddonManifest | null,
  profile: AddonProfile,
  keys: string[],
): string {
  const parts: string[] = [];
  for (const key of keys) {
    const field = manifest?.config?.[key];
    if (!field) continue;
    const value = profile[key];
    if (Array.isArray(value)) {
      parts.push(value.length > 0 ? value.join(", ") : "none");
    } else if (value === undefined) {
      parts.push("not set");
    } else {
      parts.push(String(value));
    }
  }
  return parts.join(" · ");
}

export { addonConfigRoot };
