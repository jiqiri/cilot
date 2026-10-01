import { tool } from "@opencode-ai/plugin"
import fs from "fs/promises"
import os from "os"
import path from "path"

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
}

function resolveApiBase(): string {
  const explicit = process.env.POSTIZ_API_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, "")
  const mcp = process.env.POSTIZ_MCP_URL?.trim()
  if (!mcp) {
    throw new Error(
      "Postiz is not configured. Set POSTIZ_API_URL (for example https://postiz.example.com/api) and POSTIZ_MCP_TOKEN.",
    )
  }
  return mcp.replace(/\/mcp\/?$/, "").replace(/\/+$/, "")
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { msg?: string; message?: string }
    const message = parsed.msg ?? parsed.message
    if (message) return String(message).slice(0, 500)
  } catch {
    // Fall through to a bounded excerpt.
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 500)
}

/**
 * Roots this tool may read from.
 *
 * This tool does its own filesystem read rather than going through OpenCode's read tool, so
 * OpenCode's permission rules do not cover it, and it previously accepted any absolute
 * path: the model could name /etc/… or another account's files and the tool would read and
 * upload them. Containment is enforced here, on the realpath, because a prefix comparison
 * accepts a symlink that leaves the root.
 *
 * Configured with POSTIZ_UPLOAD_ALLOWED_ROOTS, comma separated. It defaults to the
 * generated-images directory and the process working directory, so an installation that
 * sets nothing is still confined rather than open.
 */
function allowedRoots(): string[] {
  const configured = (process.env.POSTIZ_UPLOAD_ALLOWED_ROOTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  const defaults = [
    process.env.OPENCODE_IMAGE_DIR?.trim() || path.join(dataHome, "opencode-generated-images"),
    process.cwd(),
  ];
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

async function upload(
  args: { path: string; filename?: string },
  context: { abort: AbortSignal },
) {
  const token = process.env.POSTIZ_MCP_TOKEN?.trim()
  if (!token) {
    throw new Error("Postiz is not configured. Set POSTIZ_MCP_TOKEN to the Postiz API key.")
  }

  const raw = String(args.path ?? "").trim()
  if (!raw) throw new Error("A non-empty file path is required.")
  if (raw.startsWith("data:")) {
    throw new Error("Data URIs are not accepted. Pass a saved file path from image_generate instead.")
  }
  if (/^https?:\/\//i.test(raw)) {
    throw new Error(
      "This tool uploads local files. For a remote URL use postiz_uploadFromUrlTool instead.",
    )
  }

  const requested = path.resolve(raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw)
  const localPath = await assertWithinAllowedRoot(requested)
  let bytes: Buffer
  try {
    bytes = await fs.readFile(localPath)
  } catch {
    throw new Error(`Cannot read file: ${localPath}`)
  }
  if (bytes.length === 0) throw new Error(`File is empty: ${localPath}`)

  const ext = path.extname(localPath).toLowerCase()
  const mime = MIME_TYPES[ext]
  if (!mime) {
    throw new Error(
      `Unsupported file type "${ext || "none"}". Allowed: ${Object.keys(MIME_TYPES).join(", ")}`,
    )
  }

  const filename = (args.filename?.trim() || path.basename(localPath)).replace(/[/\\]/g, "-")
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename)

  // The public API expects the raw API key, without the "Bearer" prefix that the MCP
  // transport uses.
  const response = await fetch(`${resolveApiBase()}/public/v1/upload`, {
    method: "POST",
    headers: { Authorization: token },
    body: form,
    signal: context.abort,
  })

  const body = await response.text()
  if (!response.ok) throw new Error(`Postiz upload failed (${response.status}): ${errorDetail(body)}`)

  let data: { id?: string; path?: string; name?: string }
  try {
    data = JSON.parse(body) as { id?: string; path?: string; name?: string }
  } catch {
    throw new Error("Postiz returned invalid JSON.")
  }
  if (!data.path || !/^https?:\/\//i.test(data.path)) {
    throw new Error(`Postiz did not return a hosted URL. Response: ${body.slice(0, 300)}`)
  }

  return {
    title: "Uploaded to Postiz media library",
    output:
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
  }
}

export default tool({
  description:
    "Upload a local image or video file into the Postiz media library and return the hosted URL. Use this after image_generate to turn a generated image into something attachable to a Postiz post. Postiz only accepts hosted URLs, so a locally generated file must be uploaded before it can be attached.",
  args: {
    path: tool.schema
      .string()
      .describe("Absolute path to the local file, as returned by image_generate."),
    filename: tool.schema.string().optional().describe("Optional name to store the file under."),
  },
  execute: upload,
})
