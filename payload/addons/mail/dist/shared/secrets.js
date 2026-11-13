import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
const KEY = /^[A-Z][A-Z0-9_]*$/;
export function secretsPath(configRoot, scope, accountId) {
    if (scope === "global") {
        return path.join(configRoot, "secrets.env");
    }
    if (!accountId) {
        fail("unknown_account", "A per-user credential file needs an account.");
    }
    return path.join(configRoot, "users", accountId, "secrets.env");
}
export function parseSecrets(raw) {
    const values = {};
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
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
export function loadSecrets(configRoot, scope, accountId) {
    const file = secretsPath(configRoot, scope, accountId);
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            fail("not_configured", "This mailbox has no credentials yet. An admin must add them in /addons.");
        }
        fail("upstream_error", "The credential file could not be read.");
    }
    try {
        return parseSecrets(raw);
    }
    catch {
        fail("invalid_config", "The credential file could not be parsed. An admin must rewrite it in /addons.");
    }
}
export function requireSecret(secrets, key) {
    const value = secrets[key];
    if (!value) {
        fail("missing_secret", `${key} is not set for this mailbox. An admin must add it in /addons.`);
    }
    return value;
}
export function haveAllRequired(secrets, keys) {
    return keys.every((key) => Boolean(secrets[key]));
}
