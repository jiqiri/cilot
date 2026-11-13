import fs from "node:fs/promises";
import path from "node:path";
import { fail, log } from "../shared/errors.js";
/**
 * Attachments are the one place a message can write to the workspace.
 *
 * The mailbox is read-only; the workspace is not, because a file has to land somewhere for
 * the agent to forward it. Four rules keep that from becoming a file-write primitive chosen
 * by a stranger:
 *
 *   1. The name is a basename with separators, `..`, control characters and leading dots
 *      removed. `../../etc/passwd` becomes `passwd`.
 *   2. The target directory is resolved with `realpath` and must stay inside the workspace,
 *      so a symlink planted in `mail-attachments` cannot redirect the write.
 *   3. Files are opened with `wx`, so an existing file is never overwritten and a symlink at
 *      the target is never followed. A collision gets `-1`, `-2`.
 *   4. Sizes are capped per part and per call before anything is written.
 */
export const CALL_TOTAL_LIMIT = 25 * 1024 * 1024;
export function safeAttachmentName(name, fallback) {
    const basename = path.basename(name.replace(/\\/g, "/"));
    const cleaned = basename
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/^\.+/, "")
        .replace(/[<>:"|?*]/g, "_")
        .trim();
    const chosen = cleaned || fallback || "attachment";
    return chosen.slice(0, 120);
}
export function safeDirectoryName(value) {
    const cleaned = value
        .replace(/^<|>$/g, "")
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^\.+/, "")
        .slice(0, 80);
    return cleaned || "message";
}
function isInside(root, candidate) {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
async function existingTarget(directory, name) {
    const extension = path.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    for (let index = 0; index < 100; index += 1) {
        const candidate = index === 0 ? name : `${stem}-${index}${extension}`;
        try {
            await fs.lstat(path.join(directory, candidate));
        }
        catch (error) {
            if (error.code === "ENOENT")
                return candidate;
            throw error;
        }
    }
    fail("too_large", `Could not find a free name for ${name}.`);
}
export async function saveAttachments(workspace, messageId, parts, options) {
    const perPartLimit = Math.max(1, options.attachmentMaxMB) * 1024 * 1024;
    const totalLimit = options.totalLimit ?? CALL_TOTAL_LIMIT;
    let root;
    try {
        root = await fs.realpath(workspace);
    }
    catch {
        fail("upstream_error", "The workspace directory could not be resolved.");
    }
    const base = path.join(root, "mail-attachments");
    const target = path.join(base, safeDirectoryName(messageId));
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const realTarget = await fs.realpath(target);
    if (!isInside(root, realTarget) || realTarget === root) {
        fail("upstream_error", "Refusing to write attachments outside the workspace.");
    }
    const saved = [];
    const skipped = [];
    let total = 0;
    for (const part of parts) {
        const name = safeAttachmentName(part.info.filename, `attachment-${part.info.part}`);
        const bytes = part.buffer.length;
        if (part.truncated || part.info.size > perPartLimit) {
            skipped.push({ name, size: part.info.size || bytes, limitBytes: perPartLimit });
            continue;
        }
        if (total + bytes > totalLimit) {
            skipped.push({ name, size: bytes, limitBytes: totalLimit });
            continue;
        }
        let written = false;
        for (let attempt = 0; attempt < 100 && !written; attempt += 1) {
            const candidate = await existingTarget(realTarget, name).catch(() => null);
            if (!candidate)
                break;
            const destination = path.join(realTarget, candidate);
            try {
                const handle = await fs.open(destination, "wx", 0o600);
                try {
                    await handle.writeFile(part.buffer);
                }
                finally {
                    await handle.close();
                }
                saved.push({
                    name: candidate,
                    path: destination,
                    mime: part.info.mime,
                    size: bytes,
                    inline: part.info.inline,
                    ...(part.info.mime.startsWith("image/") && bytes <= 8 * 1024 * 1024
                        ? { dataUri: imageDataUri(part.buffer, part.info.mime) }
                        : {}),
                });
                total += bytes;
                written = true;
            }
            catch (error) {
                if (error.code === "EEXIST")
                    continue;
                log(`attachment write failed: ${error.code ?? "error"}`);
                break;
            }
        }
    }
    return { directory: realTarget, saved, skipped, bytes: total };
}
export function fileUri(absolutePath) {
    return `file://${encodeURI(absolutePath)}`;
}
/** MCP image content is how OpenCode hands a picture to Telegram. */
export function imageDataUri(buffer, mime) {
    return `data:${mime};base64,${buffer.toString("base64")}`;
}
