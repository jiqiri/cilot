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

  const localPath = path.resolve(raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw)
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
