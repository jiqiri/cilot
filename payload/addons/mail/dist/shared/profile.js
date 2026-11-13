import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
export function readManifest(addonRoot) {
    const file = path.join(addonRoot, "addon.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed.scope !== "global" && parsed.scope !== "per-user") {
        throw new Error(`${file}: scope must be global or per-user`);
    }
    return parsed;
}
export function defaultProfile(manifest, addonRoot) {
    const file = path.join(addonRoot, "default-config.json");
    let seeds = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            seeds = parsed;
        }
    }
    catch {
        seeds = {};
    }
    const profile = {};
    for (const [key, field] of Object.entries(manifest.config ?? {})) {
        profile[key] = seeds[key] !== undefined ? seeds[key] : field.default;
    }
    // Keep keys the manifest does not know about. A newer add-on may own them, and dropping
    // them here would quietly destroy configuration.
    for (const [key, value] of Object.entries(seeds)) {
        if (!(key in profile))
            profile[key] = value;
    }
    return profile;
}
export function profilePath(configRoot, scope, accountId) {
    if (scope === "global") {
        return path.join(configRoot, "config.json");
    }
    if (!accountId) {
        fail("unknown_account", "A per-user profile needs an account.");
    }
    return path.join(configRoot, "users", accountId, "config.json");
}
export function loadProfile(manifest, addonRoot, configRoot, accountId) {
    const defaults = defaultProfile(manifest, addonRoot);
    const file = profilePath(configRoot, manifest.scope, accountId);
    let saved = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            saved = parsed;
        }
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            fail("invalid_config", `config.json is not valid JSON (${path.basename(file)}).`);
        }
    }
    const merged = { ...defaults, ...saved };
    validateProfile(manifest, merged);
    return merged;
}
export function validateProfile(manifest, profile) {
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
export function requireReadableScope(profile) {
    if (profile.mode !== "labels")
        return;
    const labels = Array.isArray(profile.labels) ? profile.labels : [];
    const folders = Array.isArray(profile.folders) ? profile.folders : [];
    if (labels.length === 0 && folders.length === 0) {
        fail("not_configured", "This profile is in labels mode with no labels or folders configured. An admin must name what the agent may read in /addons.");
    }
}
