import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireCredential, resolveCredential } from "../credentials.js";
import {
  readOptionalEnum,
  readOptionalString,
  readString,
  type McpTool,
  type ToolResult,
} from "../types.js";

/**
 * Generate one JPEG with Cloudflare Workers AI.
 *
 * Ported from the V1 tool, which V2 cannot load: V2's config has no `tool` key, so a
 * directory of throwaway TypeScript tools is gone and the same capabilities arrive as a
 * local MCP server instead.
 *
 * Two things are preserved exactly, because the bot depends on them:
 *
 *   - The file is written to disk under `OPENCODE_IMAGE_DIR`, and the absolute path is
 *     reported. `postiz_upload_image` takes that path, and the bot records ownership from
 *     it.
 *   - A `data:` URI for the same bytes travels as image content, so the image itself reaches
 *     Telegram without the bot having to read the file back.
 */

const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

const ASPECT_RATIO_SIZES = {
  "1:1": "1024x1024",
  "16:9": "1024x576",
  "9:16": "576x1024",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "3:2": "1024x683",
  "2:3": "683x1024",
} as const;

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;

type AspectRatio = (typeof ASPECT_RATIOS)[number];

const ACCOUNT_HINT =
  "Set CF_WORKERS_AI_ACCOUNT in the OpenCode service environment, or store it in /vault.";

const TOKEN_HINT =
  "Set CF_WORKERS_AI_TOKEN in the OpenCode service environment, or store it in /vault.";

function parseSize(value: unknown): { width: number; height: number } | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{3,4})x(\d{3,4})$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 256 || width > 1920 || height < 256 || height > 1920) return null;
  return { width, height };
}

function resolveDimensions(args: {
  size?: string | undefined;
  aspectRatio?: AspectRatio | undefined;
}): { width: number; height: number } {
  const byRatio = args.aspectRatio ? ASPECT_RATIO_SIZES[args.aspectRatio] : undefined;
  return parseSize(args.size) || parseSize(byRatio) || { width: 1200, height: 630 };
}

function slugify(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function resolveFilename(value: unknown, width: number, height: number): string {
  const requested = slugify(value);
  if (requested) return requested.toLowerCase().endsWith(".jpg") ? requested : `${requested}.jpg`;
  return `generated-image-${width}x${height}.jpg`;
}

export function resolveImageDir(): string {
  const override = process.env.OPENCODE_IMAGE_DIR?.trim();
  if (override) return override;
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode-generated-images");
}

/**
 * Files this process wrote, by absolute path.
 *
 * The generated-images directory is shared by every account, and `postiz_upload_image` reads
 * files itself rather than going through OpenCode's read permission. Without a record of who
 * produced what, any account could name another account's file and have it published to a
 * public URL. Each workspace gets its own MCP process, so "written by this process" is the
 * narrowest ownership statement the tool can make, and it is enough: another account's image
 * was written by another process.
 */
const generatedByThisProcess = new Set<string>();

export function rememberGeneratedFile(filePath: string): void {
  generatedByThisProcess.add(path.resolve(filePath));
}

export function wasGeneratedHere(filePath: string): boolean {
  return generatedByThisProcess.has(path.resolve(filePath));
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ message?: string }> };
    const messages = parsed.errors?.map((item) => item.message).filter(Boolean);
    if (messages?.length) return messages.join("; ").slice(0, 500);
  } catch {
    // Fall back to a bounded response excerpt.
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 500);
}

export const imageGenerateTool: McpTool = {
  name: "image_generate",
  description:
    "Generate one JPEG image with Cloudflare Workers AI and save it to disk. Use this for illustrations, thumbnails, featured images, and other raster image requests. Returns the saved local file path; pass that path to postiz_upload_image to attach it to a Postiz post. Supports explicit WIDTHxHEIGHT sizes and common aspect ratios.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "A detailed description of the image to generate.",
      },
      size: {
        type: "string",
        description:
          "Optional exact JPEG size, for example 1200x630 or 1080x1920 (256-1920 per side).",
      },
      aspectRatio: {
        type: "string",
        enum: [...ASPECT_RATIOS],
        description: "Optional aspect ratio. Ignored when size is provided.",
      },
      filename: {
        type: "string",
        description: "Optional descriptive filename without an extension; .jpg is added automatically.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  async run(args, context): Promise<ToolResult> {
    const prompt = readString(args, "prompt");
    const size = readOptionalString(args, "size");
    const filenameArg = readOptionalString(args, "filename");
    const aspectRatio = readOptionalEnum(args, "aspectRatio", ASPECT_RATIOS);

    const account = await resolveCredential("CF_WORKERS_AI_ACCOUNT");
    if (!account) {
      throw new Error(`Cloudflare image generation is not configured. ${ACCOUNT_HINT}`);
    }
    const token = await requireCredential("CF_WORKERS_AI_TOKEN", TOKEN_HINT);

    const { width, height } = resolveDimensions({ size, aspectRatio });
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(width));
    form.append("height", String(height));

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${MODEL}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: context.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Cloudflare image API ${response.status}: ${errorDetail(body)}`);
    }

    let data: { result?: { image?: unknown } };
    try {
      data = JSON.parse(body) as { result?: { image?: unknown } };
    } catch {
      throw new Error("Cloudflare returned invalid JSON.");
    }

    const imageBase64 = data.result?.image;
    if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
      throw new Error("Cloudflare returned no image data.");
    }

    const filename = resolveFilename(filenameArg, width, height);
    const dir = resolveImageDir();
    await fs.mkdir(dir, { recursive: true });
    const localPath = path.join(dir, filename);
    await fs.writeFile(localPath, Buffer.from(imageBase64, "base64"));
    rememberGeneratedFile(localPath);

    return {
      text:
        `Generated a ${width}x${height} JPEG image using Cloudflare Workers AI (${MODEL}).\n` +
        `Saved to: ${localPath}\n` +
        `To attach it to a Postiz post, upload the file first: postiz_upload_image({ path: "${localPath}" }).`,
      files: [
        {
          uri: `data:image/jpeg;base64,${imageBase64}`,
          mime: "image/jpeg",
          name: filename,
        },
      ],
      metadata: {
        provider: "cloudflare",
        model: MODEL,
        width,
        height,
        filename,
        mime: "image/jpeg",
        localPath,
      },
    };
  },
};
