import { tool } from "@opencode-ai/plugin"

/**
 * Checks a Postiz post body before it is scheduled.
 *
 * A prompt rule is a request, not a guarantee. The model has a strong prior towards
 * emitting markup, and Postiz renders HTML only on the platforms whose API treats the
 * field as HTML. Everywhere else the tags survive into the published post, which is how
 * `<p>` text ends up visible on a Facebook comment. This tool makes the check
 * deterministic: it reports what is actually in the string, so a failure is a fact rather
 * than something the model has to remember.
 *
 * The strictness is chosen by POSTIZ_CONTENT_FORMAT:
 *   plain (default) - any tag is an error. Use this if you do not want markup at all.
 *   html            - tags are allowed, but unsupported ones, `<u>` overlapping
 *                     `<strong>`, and text that looks like a tag are still reported.
 */

const SUPPORTED_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "strong",
  "u",
  "ul",
  "ol",
  "li",
  "br",
  "blockquote",
  "a",
  "b",
  "i",
  "em",
])

// A tag is only a tag if it is followed by a name and then a boundary, so "a < b" and
// "5 < 10" are not mistaken for markup.
const TAG_RE = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>/g
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g
const BARE_URL_RE = /https?:\/\/\S+/g

type Finding = { severity: "error" | "warning"; message: string }

function contentFormat(): "plain" | "html" {
  const raw = process.env.POSTIZ_CONTENT_FORMAT?.trim().toLowerCase()
  return raw === "html" ? "html" : "plain"
}

function check(
  args: {
    content: string
    platform?: string
    maxLength?: number
    field?: string
  },
) {
  const raw = args.content
  if (typeof raw !== "string") {
    throw new Error("`content` must be a string: the exact text you intend to put in the post.")
  }
  if (!raw.trim()) {
    throw new Error("`content` is empty. There is nothing to post.")
  }

  const format = contentFormat()
  const field = args.field?.trim() || "content"
  const platform = args.platform?.trim() || "unspecified platform"
  const findings: Finding[] = []

  const tags: { name: string; raw: string }[] = []
  for (const match of raw.matchAll(TAG_RE)) {
    tags.push({ name: match[1].toLowerCase(), raw: match[0] })
  }

  if (format === "plain") {
    if (tags.length > 0) {
      const names = [...new Set(tags.map((t) => t.name))].join(", ")
      findings.push({
        severity: "error",
        message:
          `${tags.length} HTML tag(s) (${names}) found but POSTIZ_CONTENT_FORMAT=plain, so these would ` +
          `be published as literal text. Remove every tag and separate paragraphs with a blank line.`,
      })
    }
  } else {
    const unsupported = [...new Set(tags.filter((t) => !SUPPORTED_TAGS.has(t.name)).map((t) => t.name))]
    if (unsupported.length > 0) {
      findings.push({
        severity: "warning",
        message:
          `Tag(s) not in the supported set and likely to render literally: ${unsupported.join(", ")}. ` +
          `Supported: ${[...SUPPORTED_TAGS].join(", ")}.`,
      })
    }
    if (/<u>[^<]*(?:<strong>|<b>)/i.test(raw) || /<(?:strong|b)>[^<]*<u>/i.test(raw)) {
      findings.push({
        severity: "error",
        message: "<u> and <strong> overlap on the same text. Pick one; the platform drops one.",
      })
    }
  }

  const mdImages = raw.match(MARKDOWN_IMAGE_RE)
  if (mdImages && mdImages.length > 0) {
    findings.push({
      severity: "error",
      message:
        `${mdImages.length} Markdown image(s) found: ${mdImages[0]}. Postiz does not render Markdown ` +
        `images. Use the attachments array with a hosted URL from postiz_upload_image.`,
    })
  }

  // Text that only looks like a tag is a common artefact of drafting with markup in mind.
  const almostTags = raw.match(/<\s*[a-zA-Z][a-zA-Z0-9]*[^<>]*$|^\s*[a-zA-Z][a-zA-Z0-9]*[^<>]*>/gm)
  if (almostTags && almostTags.length > 0) {
    findings.push({
      severity: "warning",
      message: `Possible unclosed or stray markup: ${almostTags.slice(0, 3).join(" ")}`,
    })
  }

  const maxLength = args.maxLength
  if (typeof maxLength === "number" && Number.isFinite(maxLength) && maxLength > 0) {
    // Compare on the text a reader sees, not on the markup around it.
    const visible = tags.length > 0 ? raw.replace(TAG_RE, "") : raw
    const length = visible.trim().length
    if (length > maxLength) {
      findings.push({
        severity: "error",
        message: `${length} visible characters exceeds the ${maxLength} limit for ${platform}. Trim by ${length - maxLength}.`,
      })
    }
  }

  const errors = findings.filter((f) => f.severity === "error")
  const warnings = findings.filter((f) => f.severity === "warning")
  const urls = raw.match(BARE_URL_RE) ?? []

  const lines: string[] = []
  lines.push(`Checked the ${field} field for ${platform} in ${format} mode.`)
  lines.push(`Visible length: ${raw.replace(TAG_RE, "").trim().length} characters.`)
  if (urls.length > 0) lines.push(`Bare URLs found: ${urls.length}. Each must be a full https URL on its own.`)
  if (errors.length === 0 && warnings.length === 0) {
    lines.push("No problems found. Safe to schedule.")
  } else {
    for (const f of errors) lines.push(`ERROR: ${f.message}`)
    for (const f of warnings) lines.push(`WARN: ${f.message}`)
    if (errors.length > 0) {
      lines.push("Do not schedule this post. Fix the errors and run this check again.")
    }
  }

  return {
    title: errors.length > 0 ? "Post content failed the check" : "Post content passed the check",
    output: lines.join("\n"),
    metadata: {
      ok: errors.length === 0,
      format,
      field,
      platform,
      errorCount: errors.length,
      warningCount: warnings.length,
      tags: tags.map((t) => t.name),
    },
  }
}

export default tool({
  description:
    "Check a Postiz post body for HTML tags, Markdown images and length before scheduling. Run this on the finished `content` of every entry in postsAndComments, and fix anything it reports. Set POSTIZ_CONTENT_FORMAT=html to allow markup; the default plain rejects every tag, because on platforms that do not render HTML the tags are published as visible text.",
  args: {
    content: tool.schema.string().describe("The exact text you will put in the post or comment."),
    platform: tool.schema.string().optional().describe("Platform name, for example facebook or linkedin."),
    maxLength: tool.schema.number().optional().describe("Character limit from postiz_integrationSchema."),
    field: tool.schema.string().optional().describe("Which field this is, default content."),
  },
  execute: check,
})
