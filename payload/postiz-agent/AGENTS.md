# Global Rules

## Image generation

`image_generate` is the image generator for every request: standalone images, images sent
back to Telegram, blog/SEO/Open Graph images, and images bound for social posts. It is the
only tool that calls Cloudflare Workers AI.

It saves each JPEG to disk and returns the absolute path in `localPath` and in its output
text. That file is the real asset. Keep the path; you will need it.

## Attaching an image to a Postiz post

Postiz schedules posts with `postsAndComments[].attachments` as an array of **hosted HTTPS
URLs**. A local file path is not a URL and a `data:` URI is not a URL. Neither can be
attached directly.

The only way to attach a locally generated image is to upload it first:

1. `image_generate` — returns `localPath`.
2. `postiz_upload_image` with that `localPath` — returns a hosted `path`.
3. `postiz_integrationSchedulePostTool` with that `path` in `attachments`.

Never pass a `localPath`, a filesystem path, or a `data:` URI into `attachments`. Never try
to make a local file reachable by Postiz over HTTP; there is no inbound port and Postiz
rejects non-public sources.

Before scheduling, confirm every `attachments` entry starts with `https://` and matches the
`path` returned by `postiz_upload_image`.

## When to use the other upload tool

`postiz_uploadFromUrlTool(url)` is correct only when the image already lives at a public
HTTPS URL you did not create, such as a link the user supplied or an asset on a CDN. Do not
use it for images produced on this machine; there is no public URL for them.

## Do not use Postiz image generation

`postiz_generateImageTool` depends on an AI provider configured on the Postiz instance. On
this instance it is not configured and returns a 500. It also cannot accept a Cloudflare
result. If you somehow need it, verify it works before relying on it.

## Reporting back

When an image is attached to a post, state that the attached file is the Cloudflare-generated
image. Report the Postiz `path` so the user can confirm which asset was published.
