import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import { getBotVersion } from "../../runtime/bot-version.js";
import { logger } from "../../utils/logger.js";

/**
 * Discovery and validation of installed add-ons.
 *
 * The manifest is the contract: the bot renders forms from `config`, writes `"<id>_*"`
 * permissions from `tools`, and refuses to enable an add-on below `minCilotVersion`. This
 * module is the only place that reads `CILOT_ADDON_ROOT`, so the install path is not
 * scattered across the bot.
 */

const ID_PATTERN = /^[a-z][a-z0-9_]{1,23}$/;
const RESERVED_IDS = new Set(["telegram", "postiz"]);

export type AddonScope = "global" | "per-user";

export type AddonConfigField =
  | { type: "string"; default?: string; label?: string; required?: boolean }
  | { type: "boolean"; default?: boolean; label?: string }
  | { type: "number"; default?: number; min?: number; max?: number; label?: string }
  | { type: "enum"; values: string[]; default?: string; label?: string }
  | { type: "string[]"; default?: string[]; label?: string };

export interface AddonSecretField {
  key: string;
  label?: string;
  required?: boolean;
  secret?: boolean;
}

export interface AddonToolField {
  name: string;
  summary?: string;
  readOnly?: boolean;
}

export interface AddonManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  entry: string;
  scope: AddonScope;
  tools: AddonToolField[];
  secrets?: AddonSecretField[];
  config?: Record<string, AddonConfigField>;
  capabilities?: { network?: string[]; fs?: string[] };
  minCilotVersion?: string;
}

export interface InstalledAddon {
  id: string;
  /** Code directory: `~/.local/share/cilot/addons/<id>`. */
  root: string;
  configRoot: string;
  stateRoot: string;
  manifest: AddonManifest | null;
  /** Set when the manifest is missing or invalid. The add-on is listed so an admin can act. */
  error?: string;
}

function configRootFor(id: string): string {
  return path.join(config.addons.configRoot, id);
}

function stateRootFor(id: string): string {
  return path.join(config.addons.stateRoot, id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVersion(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(current: string, minimum: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(minimum);
  if (!a || !b) return true; // An unparseable version must not silently block updates.
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) > (b[index] ?? 0)) return true;
    if ((a[index] ?? 0) < (b[index] ?? 0)) return false;
  }
  return true;
}

function validateManifest(id: string, raw: unknown): AddonManifest {
  if (!isRecord(raw)) throw new Error("addon.json is not an object");
  if (raw.id !== id) throw new Error(`addon.json id is "${String(raw.id)}", expected "${id}"`);
  if (!ID_PATTERN.test(id)) throw new Error(`"${id}" is not a valid add-on id`);
  if (RESERVED_IDS.has(id)) throw new Error(`"${id}" is reserved`);
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("name is missing");
  if (typeof raw.version !== "string" || !parseVersion(raw.version)) {
    throw new Error("version is not semver");
  }
  if (typeof raw.description !== "string") {
    // Description is optional but must be a string when present.
    if (raw.description !== undefined) throw new Error("description must be a string");
  }
  if (raw.scope !== "global" && raw.scope !== "per-user") {
    throw new Error("scope must be global or per-user");
  }
  if (typeof raw.entry !== "string" || !raw.entry) throw new Error("entry is missing");
  if (path.isAbsolute(raw.entry) || raw.entry.split(/[\\/]/).includes("..")) {
    throw new Error("entry must be a relative path inside the add-on");
  }
  if (!Array.isArray(raw.tools) || raw.tools.length === 0) throw new Error("tools is missing");

  const tools: AddonToolField[] = raw.tools.map((tool, index) => {
    if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name) {
      throw new Error(`tools[${index}].name is missing`);
    }
    return {
      name: tool.name,
      ...(typeof tool.summary === "string" ? { summary: tool.summary } : {}),
      ...(typeof tool.readOnly === "boolean" ? { readOnly: tool.readOnly } : {}),
    };
  });

  const secrets: AddonSecretField[] | undefined = Array.isArray(raw.secrets)
    ? raw.secrets.map((entry, index) => {
        if (!isRecord(entry) || typeof entry.key !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(entry.key)) {
          throw new Error(`secrets[${index}].key is not an environment variable name`);
        }
        return {
          key: entry.key,
          ...(typeof entry.label === "string" ? { label: entry.label } : {}),
          ...(typeof entry.required === "boolean" ? { required: entry.required } : {}),
          ...(typeof entry.secret === "boolean" ? { secret: entry.secret } : {}),
        };
      })
    : undefined;

  let addonConfig: Record<string, AddonConfigField> | undefined;
  if (raw.config !== undefined) {
    if (!isRecord(raw.config)) throw new Error("config must be an object");
    addonConfig = {};
    for (const [key, field] of Object.entries(raw.config)) {
      if (!isRecord(field) || typeof field.type !== "string") {
        throw new Error(`config.${key} has no type`);
      }
      switch (field.type) {
        case "string":
          addonConfig[key] = {
            type: "string",
            ...(typeof field.default === "string" ? { default: field.default } : {}),
            ...(typeof field.label === "string" ? { label: field.label } : {}),
            ...(typeof field.required === "boolean" ? { required: field.required } : {}),
          };
          break;
        case "boolean":
          addonConfig[key] = {
            type: "boolean",
            ...(typeof field.default === "boolean" ? { default: field.default } : {}),
            ...(typeof field.label === "string" ? { label: field.label } : {}),
          };
          break;
        case "number":
          addonConfig[key] = {
            type: "number",
            ...(typeof field.default === "number" ? { default: field.default } : {}),
            ...(typeof field.min === "number" ? { min: field.min } : {}),
            ...(typeof field.max === "number" ? { max: field.max } : {}),
            ...(typeof field.label === "string" ? { label: field.label } : {}),
          };
          break;
        case "enum":
          if (!Array.isArray(field.values) || field.values.some((value) => typeof value !== "string")) {
            throw new Error(`config.${key}.values must be a list of strings`);
          }
          addonConfig[key] = {
            type: "enum",
            values: field.values as string[],
            ...(typeof field.default === "string" ? { default: field.default } : {}),
            ...(typeof field.label === "string" ? { label: field.label } : {}),
          };
          break;
        case "string[]":
          addonConfig[key] = {
            type: "string[]",
            ...(Array.isArray(field.default)
              ? { default: field.default.filter((value): value is string => typeof value === "string") }
              : {}),
            ...(typeof field.label === "string" ? { label: field.label } : {}),
          };
          break;
        default:
          throw new Error(`config.${key} has unsupported type "${field.type}"`);
      }
    }
  }

  return {
    id,
    name: raw.name,
    version: raw.version,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    entry: raw.entry,
    scope: raw.scope,
    tools,
    ...(secrets ? { secrets } : {}),
    ...(addonConfig ? { config: addonConfig } : {}),
    ...(isRecord(raw.capabilities)
      ? {
          capabilities: {
            ...(Array.isArray(raw.capabilities.network)
              ? { network: raw.capabilities.network.filter((value): value is string => typeof value === "string") }
              : {}),
            ...(Array.isArray(raw.capabilities.fs)
              ? { fs: raw.capabilities.fs.filter((value): value is string => typeof value === "string") }
              : {}),
          },
        }
      : {}),
    ...(typeof raw.minCilotVersion === "string" ? { minCilotVersion: raw.minCilotVersion } : {}),
  };
}

async function loadOne(id: string): Promise<InstalledAddon> {
  const root = path.join(config.addons.root, id);
  const base: InstalledAddon = {
    id,
    root,
    configRoot: configRootFor(id),
    stateRoot: stateRootFor(id),
    manifest: null,
  };

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path.join(root, "addon.json"), "utf8"));
  } catch (error) {
    return { ...base, error: `addon.json could not be read: ${(error as Error).message}` };
  }

  let manifest: AddonManifest;
  try {
    manifest = validateManifest(id, raw);
  } catch (error) {
    return { ...base, error: (error as Error).message };
  }

  const entry = path.resolve(root, manifest.entry);
  const relative = path.relative(root, entry);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ...base, manifest, error: "entry escapes the add-on directory" };
  }
  try {
    await fs.access(entry);
  } catch {
    return { ...base, manifest, error: `entry file is missing: ${manifest.entry}` };
  }

  const botVersion = await getBotVersion();
  if (manifest.minCilotVersion && !versionAtLeast(botVersion, manifest.minCilotVersion)) {
    return {
      ...base,
      manifest,
      error: `requires Cilot ${manifest.minCilotVersion}, this is ${botVersion}`,
    };
  }

  return { ...base, manifest };
}

export async function listInstalledAddons(): Promise<InstalledAddon[]> {
  let entries;
  try {
    entries = await fs.readdir(config.addons.root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    logger.warn(`[Addons] Could not read ${config.addons.root}: ${(error as Error).message}`);
    return [];
  }

  const addons: InstalledAddon[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!ID_PATTERN.test(entry.name) || RESERVED_IDS.has(entry.name)) continue;
    addons.push(await loadOne(entry.name));
  }
  return addons.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getInstalledAddon(id: string): Promise<InstalledAddon | null> {
  if (!ID_PATTERN.test(id)) return null;
  try {
    await fs.access(path.join(config.addons.root, id, "addon.json"));
  } catch {
    return null;
  }
  return loadOne(id);
}

export function addonConfigRoot(id: string): string {
  return configRootFor(id);
}

export function addonStateRoot(id: string): string {
  return stateRootFor(id);
}

export function addonEntryPath(addon: InstalledAddon): string {
  return path.resolve(addon.root, addon.manifest?.entry ?? "dist/server.js");
}

export function configLabel(field: AddonConfigField): string {
  return field.label ?? field.type;
}
