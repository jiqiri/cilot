import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireCredential, resolveCredential } from "../credentials.js";
import { readOptionalString, readString, type McpTool, type ToolResult } from "../types.js";
import { resolveImageDir, wasGeneratedHere } from "./image-generate.js";

/**
 * Uploads a local media file into the Postiz media library and returns the hosted
 * `path` that `postiz_integrationSchedulePostTool` expects in `attachments`.
 *
 * This exists because the Postiz MCP surface only exposes `uploadFromUrlTool(url)`,
 * which requires a publicly reachable HTTPS URL. There is no MCP tool that accepts
 * bytes or a local path, so files produced on this machine (for example by
 * `image_generate`) cannot reach Postiz without going through the public API.
 */

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp4": "video/mp4",
};

const TOKEN_HINT = "Set POSTIZ_MCP_TOKEN in the OpenCode service environment, or store it in /vault.";

async function resolveApiBase(): Promise<string> {
  const explicit = (await resolveCredential("POSTIZ_API_URL"))?.replace(/\/+$/, "");
  if (explicit) return explicit;
  const mcp = await resolveCredential("POSTIZ_MCP_URL");
  if (!mcp) {
    throw new Error(
      "Postiz is not configured. Set POSTIZ_API_URL (for example https://postiz.example.com/api) and POSTIZ_MCP_TOKEN.",
    );
  }
  return mcp.replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { msg?: string; message?: string };
    const message = parsed.msg ?? parsed.message;
    if (message) return String(message).slice(0, 500);
  } catch {
    // Fall through to a bounded excerpt.
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * Roots this tool may read from.
 *
 * This tool does its own filesystem read rather than going through OpenCode's read tool, so
 * OpenCode's permission rules do not cover it, and it previously accepted any absolute
 * path: the model could name /etc/... or another account's files and the tool would read and
 * upload them. Containment is enforced here, on the realpath, because a prefix comparison
 * accepts a symlink that leaves the root.
 *
 * Configured with POSTIZ_UPLOAD_ALLOWED_ROOTS, comma separated. It defaults to the
 * generated-images directory and the assistant working directory, so an installation that
 * sets nothing is still confined rather than open.
 */
function allowedRoots(): string[] {
  const configured = (process.env.POSTIZ_UPLOAD_ALLOWED_ROOTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const defaults = [resolveImageDir(), process.env.MCP_WORKSPACE_ROOT?.trim() || process.cwd()];
  return [...new Set([...configured, ...defaults])];
}

async function realpathOf(target: string): Promise<string> {
  const { realpath } = await import("fs/promises");
  const absolute = path.resolve(target);
  try {
    return await realpath(absolute);
  } catch {
    // Resolve the deepest existing ancestor so a not-yet-created file inside a real root
    // is still describable, while a traversal through a missing component cannot match.
    let current = absolute;
    const tail: string[] = [];
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.unshift(path.basename(current));
      current = parent;
      try {
        return path.join(await realpath(current), ...tail);
      } catch {
        continue;
      }
    }
  }
}

async function assertWithinAllowedRoot(candidate: string): Promise<string> {
  const resolved = await realpathOf(candidate);
  for (const root of allowedRoots()) {
    const resolvedRoot = await realpathOf(root);
    if (resolved === resolvedRoot) return resolved;
    if (resolved.startsWith(resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep)) {
      return resolved;
    }
  }
  throw new Error(
    "Refusing to read that path: it is outside the directories this tool may read. " +
      `Allowed roots: ${allowedRoots().join(", ")}. ` +
      "Copy the file into your workspace, or ask the operator to widen POSTIZ_UPLOAD_ALLOWED_ROOTS.",
  );
}

/**
 * Refuses an image that lives in the shared directory but was not produced here.
 *
 * The directory is shared by every account, and this tool reads it directly, so the root
 * check alone would let one account upload another account's image to a public URL. Each
 * workspace runs its own MCP process, so a file this process did not write belongs to
 * somebody else. A file the account copied into its own workspace is unaffected.
 */
async function assertOwnedGeneratedImage(localPath: string): Promise<void> {
  const imagesRoot = await realpathOf(resolveImageDir());
  const insideImagesRoot =
    localPath === imagesRoot || localPath.startsWith(imagesRoot + path.sep);
  if (!insideImagesRoot || wasGeneratedHere(localPath)) {
    return;
  }

  throw new Error(
    "Refusing to upload that file: it is in the shared generated-images directory but was not " +
      "generated in this session. Generate the image again with image_generate, or copy the file " +
      "into your workspace and upload the copy.",
  );
}

export const postizUploadImageTool: McpTool = {
  name: "postiz_upload_image",
  description:
    "Upload a local image or video file into the Postiz media library and return the hosted URL. Use this after image_generate to turn a generated image into something attachable to a Postiz post. Postiz only accepts hosted URLs, so a locally generated file must be uploaded before it can be attached.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the local file, as returned by image_generate.",
      },
      filename: {
        type: "string",
        description: "Optional name to store the file under.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(args, context): Promise<ToolResult> {
    const token = await requireCredential("POSTIZ_MCP_TOKEN", TOKEN_HINT);
    const raw = readString(args, "path");
    const filenameArg = readOptionalString(args, "filename");

    if (raw.startsWith("data:")) {
      throw new Error("Data URIs are not accepted. Pass a saved file path from image_generate instead.");
    }
    if (/^https?:\/\//i.test(raw)) {
      throw new Error(
        "This tool uploads local files. For a remote URL use postiz_uploadFromUrlTool instead.",
      );
    }

    const requested = path.resolve(raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw);
    const localPath = await assertWithinAllowedRoot(requested);
    await assertOwnedGeneratedImage(localPath);

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(localPath);
    } catch {
      throw new Error(`Cannot read file: ${localPath}`);
    }
    if (bytes.length === 0) throw new Error(`File is empty: ${localPath}`);

    const ext = path.extname(localPath).toLowerCase();
    const mime = MIME_TYPES[ext];
    if (!mime) {
      throw new Error(
        `Unsupported file type "${ext || "none"}". Allowed: ${Object.keys(MIME_TYPES).join(", ")}`,
      );
    }

    const filename = (filenameArg || path.basename(localPath)).replace(/[/\\]/g, "-");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);

    // The public API expects the raw API key, without the "Bearer" prefix that the MCP
    // transport uses.
    const response = await fetch(`${await resolveApiBase()}/public/v1/upload`, {
      method: "POST",
      headers: { Authorization: token },
      body: form,
      signal: context.signal,
    });

    const body = await response.text();
    if (!response.ok) throw new Error(`Postiz upload failed (${response.status}): ${errorDetail(body)}`);

    let data: { id?: string; path?: string; name?: string };
    try {
      data = JSON.parse(body) as { id?: string; path?: string; name?: string };
    } catch {
      throw new Error("Postiz returned invalid JSON.");
    }
    if (!data.path || !/^https?:\/\//i.test(data.path)) {
      throw new Error(`Postiz did not return a hosted URL. Response: ${body.slice(0, 300)}`);
    }

    return {
      text:
        `Uploaded ${filename} (${mime}, ${bytes.length} bytes) to the Postiz media library.\n` +
        `id: ${data.id ?? "unknown"}\n` +
        `path: ${data.path}\n` +
        `Use this exact path value in postsAndComments[].attachments.`,
      metadata: {
        id: data.id,
        path: data.path,
        mime,
        bytes: bytes.length,
        localPath,
      },
    };
  },
};
