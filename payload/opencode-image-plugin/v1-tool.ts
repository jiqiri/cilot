import { tool } from "@opencode-ai/plugin"

const MODEL = "@cf/black-forest-labs/flux-2-klein-4b"

const ASPECT_RATIO_SIZES = {
  "1:1": "1024x1024",
  "16:9": "1024x576",
  "9:16": "576x1024",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "3:2": "1024x683",
  "2:3": "683x1024",
} as const

type AspectRatio = keyof typeof ASPECT_RATIO_SIZES

function parseSize(value: unknown): { width: number; height: number } | null {
  if (typeof value !== "string") return null
  const match = value.trim().match(/^(\d{3,4})x(\d{3,4})$/i)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 256 || width > 1920 || height < 256 || height > 1920) return null
  return { width, height }
}

function resolveDimensions(args: { size?: string; aspectRatio?: AspectRatio }) {
  const aspectRatioSize = args.aspectRatio ? ASPECT_RATIO_SIZES[args.aspectRatio] : undefined
  return parseSize(args.size) || parseSize(aspectRatioSize) || {
    width: 1200,
    height: 630,
  }
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
    .slice(0, 100)
}

function resolveFilename(value: unknown, width: number, height: number): string {
  const requested = slugify(value)
  if (requested) return requested.toLowerCase().endsWith(".jpg") ? requested : `${requested}.jpg`
  return `generated-image-${width}x${height}.jpg`
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ message?: string }> }
    const messages = parsed.errors?.map((item) => item.message).filter(Boolean)
    if (messages?.length) return messages.join("; ").slice(0, 500)
  } catch {
    // Fall back to a bounded response excerpt.
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 500)
}

async function generate(
  args: { prompt: string; size?: string; aspectRatio?: AspectRatio; filename?: string },
  context: { abort: AbortSignal },
) {
  const account = process.env.CF_WORKERS_AI_ACCOUNT?.trim()
  const token = process.env.CF_WORKERS_AI_TOKEN?.trim()
  if (!account || !token) {
    throw new Error("Cloudflare image generation is not configured. Set CF_WORKERS_AI_ACCOUNT and CF_WORKERS_AI_TOKEN.")
  }

  const prompt = args.prompt.trim()
  if (!prompt) throw new Error("A non-empty image prompt is required.")
  const { width, height } = resolveDimensions(args)
  const form = new FormData()
  form.append("prompt", prompt)
  form.append("width", String(width))
  form.append("height", String(height))

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${MODEL}`
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: context.abort,
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Cloudflare image API ${response.status}: ${errorDetail(body)}`)

  let data: { result?: { image?: unknown } }
  try {
    data = JSON.parse(body) as { result?: { image?: unknown } }
  } catch {
    throw new Error("Cloudflare returned invalid JSON.")
  }

  const imageBase64 = data.result?.image
  if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
    throw new Error("Cloudflare returned no image data.")
  }

  const filename = resolveFilename(args.filename, width, height)
  return {
    title: "Cloudflare image generated",
    output: `Generated a ${width}x${height} JPEG image using Cloudflare Workers AI (${MODEL}).`,
    metadata: { provider: "cloudflare", model: MODEL, width, height, filename, mime: "image/jpeg" },
    attachments: [
      {
        type: "file" as const,
        mime: "image/jpeg",
        url: `data:image/jpeg;base64,${imageBase64}`,
        filename,
      },
    ],
  }
}

export default tool({
  description:
    "Generate one JPEG image with Cloudflare Workers AI. Use this for illustrations, thumbnails, featured images, and other raster image requests. Supports explicit WIDTHxHEIGHT sizes and common aspect ratios.",
  args: {
    prompt: tool.schema.string().describe("A detailed description of the image to generate."),
    size: tool.schema.string().optional().describe("Optional exact JPEG size, for example 1200x630 or 1080x1920 (256-1920 per side)."),
    aspectRatio: tool.schema.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]).optional().describe("Optional aspect ratio. Ignored when size is provided."),
    filename: tool.schema.string().optional().describe("Optional descriptive filename without an extension; .jpg is added automatically."),
  },
  execute: generate,
})
