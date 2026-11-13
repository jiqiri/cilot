import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";

/**
 * Profiles are read per call and validated against the manifest.
 *
 * The manifest is the schema. A saved value that violates it is `invalid_config`, never a
 * silent fallback: falling back to a default is how access widens without anyone deciding it
 * should. Unknown keys are preserved by the caller, so a newer manifest can add a field
 * without an older one wiping it.
 */

export type ConfigField =
  | { type: "string"; default?: string; label?: string; required?: boolean }
  | { type: "boolean"; default?: boolean; label?: string }
  | { type: "number"; default?: number; min?: number; max?: number; label?: string }
  | { type: "enum"; values: string[]; default?: string; label?: string }
  | { type: "string[]"; default?: string[]; label?: string };

export interface ConfigSchema {
  [key: string]: ConfigField;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  scope: "global" | "per-user";
  tools: Array<{ name: string; summary?: string; readOnly?: boolean }>;
  secrets?: Array<{ key: string; label?: string; required?: boolean; secret?: boolean }>;
  config?: ConfigSchema;
  minCilotVersion?: string;
}

export type Profile = Record<string, unknown>;

export function readManifest(addonRoot: string): Manifest {
  const file = path.join(addonRoot, "addon.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  if (parsed.scope !== "global" && parsed.scope !== "per-user") {
    throw new Error(`${file}: scope must be global or per-user`);
  }
  return parsed;
}

export function defaultProfile(manifest: Manifest, addonRoot: string): Profile {
  const file = path.join(addonRoot, "default-config.json");
  let seeds: Profile = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      seeds = parsed as Profile;
    }
  } catch {
    seeds = {};
  }

  const profile: Profile = {};
  for (const [key, field] of Object.entries(manifest.config ?? {})) {
    profile[key] = seeds[key] !== undefined ? seeds[key] : field.default;
  }
  // Keep keys the manifest does not know about. A newer add-on may own them, and dropping
  // them here would quietly destroy configuration.
  for (const [key, value] of Object.entries(seeds)) {
    if (!(key in profile)) profile[key] = value;
  }
  return profile;
}

export function profilePath(
  configRoot: string,
  scope: "global" | "per-user",
  accountId: string | null,
): string {
  if (scope === "global") {
    return path.join(configRoot, "config.json");
  }
  if (!accountId) {
    fail("unknown_account", "A per-user profile needs an account.");
  }
  return path.join(configRoot, "users", accountId, "config.json");
}

export function loadProfile(
  manifest: Manifest,
  addonRoot: string,
  configRoot: string,
  accountId: string | null,
): Profile {
  const defaults = defaultProfile(manifest, addonRoot);
  const file = profilePath(configRoot, manifest.scope, accountId);

  let saved: Profile = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      saved = parsed as Profile;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail("invalid_config", `config.json is not valid JSON (${path.basename(file)}).`);
    }
  }

  const merged: Profile = { ...defaults, ...saved };
  validateProfile(manifest, merged);
  return merged;
}

export function validateProfile(manifest: Manifest, profile: Profile): void {
  for (const [key, field] of Object.entries(manifest.config ?? {})) {
    const value = profile[key];
    if (value === undefined) {
      if (field.type === "string" && "required" in field && field.required) {
        fail("invalid_config", `Field "${key}" is required.`);
      }
      continue;
    }

    switch (field.type) {
      case "string":
        if (typeof value !== "string") {
          fail("invalid_config", `Field "${key}" must be a string.`);
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          fail("invalid_config", `Field "${key}" must be true or false.`);
        }
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          fail("invalid_config", `Field "${key}" must be a number.`);
        }
        if (field.min !== undefined && value < field.min) {
          fail("invalid_config", `Field "${key}" must be at least ${field.min}.`);
        }
        if (field.max !== undefined && value > field.max) {
          fail("invalid_config", `Field "${key}" must be at most ${field.max}.`);
        }
        break;
      case "enum":
        if (typeof value !== "string" || !field.values.includes(value)) {
          fail("invalid_config", `Field "${key}" must be one of: ${field.values.join(", ")}.`);
        }
        break;
      case "string[]":
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
          fail("invalid_config", `Field "${key}" must be a list of strings.`);
        }
        break;
      default:
        fail("invalid_config", `Field "${key}" has an unsupported type.`);
    }
  }
}

/** A profile that switches to labels mode must name at least one label. */
export function requireReadableScope(profile: Profile): void {
  if (profile.mode !== "labels") return;
  const labels = Array.isArray(profile.labels) ? profile.labels : [];
  const folders = Array.isArray(profile.folders) ? profile.folders : [];
  if (labels.length === 0 && folders.length === 0) {
    fail(
      "not_configured",
      "This profile is in labels mode with no labels or folders configured. An admin must name what the agent may read in /addons.",
    );
  }
}
