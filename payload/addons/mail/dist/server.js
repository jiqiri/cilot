#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createProtocol } from "./protocol.js";
import { log, errorText } from "./shared/errors.js";
import { tools, manifestInfo } from "./tools.js";
import { resolveAccount } from "./shared/identity.js";
import { requireGrant } from "./shared/policy.js";
import { loadProfile } from "./shared/profile.js";
import { loadSecrets, haveAllRequired } from "./shared/secrets.js";
import { listFolders } from "./mail/imap.js";
/**
 * Two modes: the MCP server OpenCode starts, and `--selftest`, which `/addons → Test` runs.
 *
 * Stdout is protocol frames only. The console is redirected to stderr so a stray log from a
 * dependency cannot split a frame and break every later call in the session.
 */
async function selftest() {
    const result = { ok: false };
    try {
        const account = resolveAccount(manifestInfo.manifest.scope);
        result.account = account.id;
        if (!account.id)
            throw new Error("unknown_account: no personal workspace");
        requireGrant(manifestInfo.configRoot, account.id);
        const profile = loadProfile(manifestInfo.manifest, manifestInfo.addonRoot, manifestInfo.configRoot, account.id);
        const secrets = loadSecrets(manifestInfo.configRoot, manifestInfo.manifest.scope, account.id);
        const required = (manifestInfo.manifest.secrets ?? [])
            .filter((entry) => entry.required !== false)
            .map((entry) => entry.key);
        if (!haveAllRequired(secrets, required)) {
            throw new Error("missing_secret: required credentials are not set");
        }
        const folders = await listFolders(secrets);
        result.ok = true;
        result.mode = profile.mode;
        result.folders = folders.length;
        result.unread = folders.reduce((sum, folder) => sum + (folder.unseen ?? 0), 0);
    }
    catch (error) {
        result.error = errorText(error);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 1);
}
function serve() {
    // Safety net: stdout is a protocol stream.
    // eslint-disable-next-line no-console
    console.log = (...args) => {
        process.stderr.write(`${args.map(String).join(" ")}\n`);
    };
    log(`mail add-on started (pid ${process.pid}, ${tools.length} tools)`);
    const protocol = createProtocol(tools, {
        write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
        log,
    });
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            return;
        void protocol.handleLine(trimmed);
    });
    lines.on("close", () => {
        protocol.abortAll();
        process.exit(0);
    });
    process.stdout.on("error", () => process.exit(0));
}
if (process.argv.includes("--selftest")) {
    void selftest();
}
else {
    serve();
}
