import fs from "node:fs";
import path from "node:path";
import { log } from "./errors.js";
const MAX_BYTES = 1024 * 1024;
function rotate(file) {
    try {
        if (!fs.existsSync(file))
            return;
        if (fs.statSync(file).size < MAX_BYTES)
            return;
        if (fs.existsSync(`${file}.2`))
            fs.rmSync(`${file}.2`, { force: true });
        if (fs.existsSync(`${file}.1`))
            fs.renameSync(`${file}.1`, `${file}.2`);
        fs.renameSync(file, `${file}.1`);
    }
    catch {
        // Rotation is housekeeping. A full disk must not turn a successful tool call into an
        // error the model reports to the user.
    }
}
export function appendAudit(stateRoot, entry) {
    const file = path.join(stateRoot, "audit.log");
    try {
        fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
        rotate(file);
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }
    catch (error) {
        log(`audit write failed: ${error.code ?? "error"}`);
    }
}
