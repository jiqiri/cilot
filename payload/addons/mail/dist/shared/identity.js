import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail } from "./errors.js";
const DIGITS = /^\d+$/;
function defaultUserRoot() {
    return path.join(os.homedir(), ".local", "share", "tg-workspaces", "users");
}
export function resolveAccount(scope, cwd = process.cwd()) {
    if (scope === "global") {
        return { id: null };
    }
    const root = path.resolve(process.env.CILOT_USER_ROOT?.trim() || defaultUserRoot());
    let realCwd;
    let realRoot;
    try {
        realCwd = fs.realpathSync(cwd);
        realRoot = fs.realpathSync(root);
    }
    catch {
        fail("unknown_account", "The workspace directory could not be resolved.");
    }
    const relative = path.relative(realRoot, realCwd);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        fail("unknown_account", "This session is not running inside a personal workspace, so the mail add-on cannot tell which account it is serving. Switch to your own workspace in /projects.");
    }
    const first = relative.split(path.sep)[0] ?? "";
    if (!DIGITS.test(first)) {
        fail("unknown_account", "This session is not running inside a personal workspace, so the mail add-on cannot tell which account it is serving. Switch to your own workspace in /projects.");
    }
    return { id: first };
}
