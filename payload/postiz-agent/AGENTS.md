# Global Rules

These are the rules that apply to every task, regardless of which agent is active. Rules for
a specific workflow live with that workflow's agent, not here.

## Image generation

`image_generate` (Cloudflare Workers AI) is the only image generator. Use it for every image:
standalone images, images sent back to Telegram, blog/SEO/Open Graph images, and images bound
for social posts. Never invent a different image tool.

It saves each JPEG under `$XDG_DATA_HOME/opencode-generated-images` and reports the absolute
path as `localPath`. That file is the real asset; the `data:` URI on the attachment is for
preview and Telegram delivery only.

`postiz_generateImageTool` is not usable. It needs an AI provider key configured on the Postiz
instance and returns HTTP 500 without one. It also cannot accept a Cloudflare result.

## Publishing to social channels

Postiz publishing, including the image upload step and the per-platform rules for Facebook,
Instagram, LinkedIn, X, TikTok, WordPress and the rest, is owned by the `postiz-social` agent.
Switch to it when the task is about creating or scheduling a post. Do not work from memory here.

The one rule that is cheap and worth keeping globally: a Postiz post carries hosted HTTPS URLs
in `postsAndComments[].attachments`. A local file path or a `data:` URI is not a URL and will
fail the post. If you generated an image in this session, upload it before trying to attach it.

## Reporting back

Be specific about what you actually did. Do not claim a file was attached, published, or
uploaded unless a tool call returned confirmation. Do not imply a generated image is the one
that was published when a different one was used.
