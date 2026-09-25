---
name: Cloudflare Image Generation
description: Generate images and JPEGs with the Cloudflare Workers AI image_generate tool, including platform-aware dimensions and descriptive filenames.
metadata:
  opencode/autoinvoke: true
---

Use the `image_generate` tool for image requests.

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

The tool returns the generated JPEG as an attachment. After generating, tell the user what was created and mention the filename.
