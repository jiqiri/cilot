import { tool } from "@opencode-ai/plugin"

/**
 * Checks a Postiz post body before it is scheduled.
 *
 * A prompt rule is a request, not a guarantee, and the failure this guards against is not
 * only tags leaking into a published post. The model also reaches for inline emphasis while
 * *drafting*: `<em>`, `<strong>`, `<b>` appear in ordinary social copy because markup is its
 * default way to express stress, and a social network renders none of it. So the copy
 * arrives with tags the writer never meant as tags. This tool makes the check deterministic:
 * it reports what is actually in the string, so a failure is a fact rather than something
 * the model has to remember.
 *
 * The rule is per platform, not global. That is the point: social networks take plain text
 * and nothing else, while WordPress content genuinely needs `<p>` because the site's plugin
 * turns a bare image URL sitting in its own paragraph into a rendered image. Treating that as
 * a global rule is what produced the conflict. Here it is a property of the platform, so a
 * WordPress post may carry markup and a Facebook post may not, in the same run, with no
 * setting to reconcile.
 *
 * POSTIZ_CONTENT_FORMAT loosens the whole thing if someone wants it:
 *   strict (default, "plain" accepted as an alias)
 *       - social platforms: no tag at all is allowed
 *       - WordPress and other article targets: the supported set is allowed
 *   html
 *       - the supported set is allowed everywhere
 * Unsupported tags, `<u>` overlapping `<strong>`, and stray markup are still reported in
 * either mode.
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

/**
 * The only targets whose `content` field is treated as HTML. Everything else is a social
 * network, where markup is either stripped or shown literally.
 */
const HTML_TARGETS = new Set(["wordpress", "blog", "webflow", "ghost", "medium", "substack"])

/**
 * Tags a writer reaches for out of habit rather than need. Worth calling out by name,
 * because "remove the markup" reads as being told off while "you used <em> to stress a word"
 * names the actual mistake and is easier to not repeat.
 */
const INLINE_EMPHASIS_TAGS = new Set(["em", "i", "b", "strong", "u", "span", "small", "sup", "sub"])

// A tag is only a tag if it is followed by a name and then a boundary, so "a < b" and
// "5 < 10" are not mistaken for markup.
const TAG_RE = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>/g
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g
const BARE_URL_RE = /https?:\/\/\S+/g

type Finding = { severity: "error" | "warning"; message: string }

function contentFormat(): "strict" | "html" {
  const raw = process.env.POSTIZ_CONTENT_FORMAT?.trim().toLowerCase()
  return raw === "html" ? "html" : "strict"
}

/**
 * Whether this platform's `content` may carry markup. Article targets may, social networks
 * may not, and that difference is not configurable per post because it is a property of the
 * destination rather than a matter of taste.
 */
function allowsHtml(platform: string, format: "strict" | "html"): boolean {
  if (format === "html") return true
  return HTML_TARGETS.has(platform.trim().toLowerCase())
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
  const htmlAllowed = allowsHtml(platform, format)
  const findings: Finding[] = []

  const tags: { name: string; raw: string }[] = []
  for (const match of raw.matchAll(TAG_RE)) {
    tags.push({ name: match[1].toLowerCase(), raw: match[0] })
  }

  if (!htmlAllowed) {
    if (tags.length > 0) {
      const names = [...new Set(tags.map((t) => t.name))].join(", ")
      const emphasis = [...new Set(tags.map((t) => t.name))].filter((n) => INLINE_EMPHASIS_TAGS.has(n))
      findings.push({
        severity: "error",
        message:
          `${tags.length} HTML tag(s) (${names}) found. ${platform} post copy is plain text, so these ` +
          `are not formatting here: they are either stripped or published as visible text.` +
          (emphasis.length > 0
            ? ` You used <${emphasis.join(">, <")}> to stress a word; a social network renders none of it. ` +
              `Get the emphasis from the sentence instead.`
            : ` Separate paragraphs with a blank line instead.`) +
          ` Remove every tag and rewrite.`,
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
  lines.push(
    `Checked the ${field} field for ${platform} in ${format} mode ` +
      `(${htmlAllowed ? "markup permitted on this target" : "plain text only on this target"}).`,
  )
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
      htmlAllowed,
      /** Set when the copy is plain text and no markup is permitted for this target. */
      requiresPlainText: !htmlAllowed,
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
    "Check a Postiz post body before scheduling: HTML tags, inline emphasis tags, Markdown images and length. Run it on the finished `content` of every entry in postsAndComments, including comments, and rewrite anything it reports. Social platform copy is plain text with no markup at all: do not use <em>, <strong>, <i> or <b> to stress a word, and do not wrap paragraphs in <p>. Article targets such as WordPress may use <p>. Set POSTIZ_CONTENT_FORMAT=html to allow markup everywhere.",
  args: {
    content: tool.schema.string().describe("The exact text you will put in the post or comment."),
    platform: tool.schema.string().optional().describe("Platform name, for example facebook or linkedin."),
    maxLength: tool.schema.number().optional().describe("Character limit from postiz_integrationSchema."),
    field: tool.schema.string().optional().describe("Which field this is, default content."),
  },
  execute: check,
})
