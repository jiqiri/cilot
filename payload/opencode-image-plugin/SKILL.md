---
name: Cloudflare Image Generation
description: Generate images and JPEGs with the Cloudflare Workers AI image_generate tool, including platform-aware dimensions and descriptive filenames.
metadata:
  opencode/autoinvoke: true
---

Use the `image_generate` tool for all image requests. It is the only Cloudflare Workers AI
image generator.

The tool returns the generated JPEG as an attachment and saves it to disk. Its output text
reports the absolute `localPath` of the saved file, and the same path is in the `localPath`
metadata field. Keep that path: it is the only way to reach the bytes later.

The `data:image/jpeg;base64,...` URL on the attachment is for preview and Telegram delivery
only. It is not a hosted URL and must never be passed to Postiz.

To attach a generated image to a Postiz post, pass the saved `localPath` to
`postiz_upload_image`, which uploads it to the Postiz media library and returns a hosted
`path`. Do not use `postiz_generateImageTool`; it is not configured on this instance. See
the `postiz-guidance` skill. Never invent a different image tool.

Choose dimensions from the user's request first. If no size is supplied, use these defaults:

- Blog, SEO, featured image, Open Graph, Facebook: `1200x630`
- LinkedIn: `1200x627`
- X/Twitter: `1200x675`
- YouTube thumbnail: `1280x720`
- Instagram square: `1080x1080`
- Instagram portrait/feed: `1080x1350`
- Instagram Story/Reel and TikTok: `1080x1920`
- Pinterest: `1000x1500`
- Generic image: `1024x1024`

Always provide a concise, descriptive, lowercase filename with words separated by hyphens. Describe the subject and purpose, not the full prompt. Do not use generic names such as `image`, `photo`, `generated-image`, or random IDs.

The tool returns the generated JPEG as an attachment and reports the saved file path. After generating, tell the user what was created, mention the filename, and mention the saved path.
