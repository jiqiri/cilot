import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { log } from "./errors.js";
const EMPTY = { version: 1, default: "admin-only", users: {} };
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function readPolicy(configRoot) {
    const file = path.join(configRoot, "policy.json");
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return { ...EMPTY, users: {} };
        }
        log(`could not read policy.json: ${error.code ?? "error"}`);
        return { ...EMPTY, users: {} };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        log("policy.json is not valid JSON; every account is off");
        return { ...EMPTY, users: {} };
    }
    if (!isRecord(parsed)) {
        log("policy.json is not an object; every account is off");
        return { ...EMPTY, users: {} };
    }
    const users = {};
    if (isRecord(parsed.users)) {
        for (const [id, row] of Object.entries(parsed.users)) {
            if (!isRecord(row))
                continue;
            const grant = row.grant === "use" ? "use" : "off";
            users[id] = {
                grant,
                ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
            };
        }
    }
    const policyDefault = parsed.default === "all-users" ? "all-users" : "admin-only";
    return {
        version: typeof parsed.version === "number" ? parsed.version : 1,
        default: policyDefault,
        users,
    };
}
export function grantFor(policy, accountId) {
    if (accountId === null) {
        // A global add-on has no per-account grant. Reaching this is a manifest bug, not a user
        // action, so deny rather than assume.
        return "off";
    }
    const row = policy.users[accountId];
    if (row) {
        return row.grant === "use" ? "use" : "off";
    }
    return policy.default === "all-users" ? "use" : "off";
}
export function requireGrant(configRoot, accountId) {
    const granted = grantFor(readPolicy(configRoot), accountId);
    if (granted !== "use") {
        fail("not_granted", "This account has no access to the mail add-on. An admin can grant it in /addons.");
    }
    return granted;
}
