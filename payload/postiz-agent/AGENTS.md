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

## WordPress channel: put image URLs in the text, never image tags

The WordPress channel goes through the same Postiz tools as every other channel. Do not
publish WordPress posts by calling the site's API directly.

Postiz sanitizes post content server side and keeps only a short list of tags: `p`, `br`,
`strong`, `u`, `a`, `ul`, `li`, `h1`, `h2`, `h3`, `span`. There is no `img`, `figure` or
`figcaption`, and no `src` attribute, so every image tag is removed before the post reaches
WordPress.

Therefore, to place an image in the middle of an article, put the **plain hosted image URL on
its own line inside a paragraph**. A plugin on the site turns that URL into a rendered image
with its caption underneath.

```html
<p>Paragraph before the image.</p>
<p>https://host.example/path/to/image.jpg</p>
<p>Paragraph after the image.</p>
```

Rules for WordPress posts:

1. Generate the image with `image_generate`, then upload it with `postiz_upload_image` to get
   the hosted URL. Only that hosted URL may appear in the content.
2. One image URL per paragraph, alone in that paragraph, so the site plugin can match it.
3. Never write `<img>`, `<figure>`, `<figcaption>`, Markdown image syntax, or an HTML comment
   carrying a URL. All of them are stripped.
4. The featured image is separate: set `settings.main_image` as an object with the media `id`
   and the hosted `path`. Postiz uploads it into the WordPress media library and sets it as the
   featured image. Featured images are not affected by the content sanitizer.
5. `title`, `type` and `status` are plain strings. Do not send `categories` or `tags` through
   the schedule tool; it cannot carry numeric arrays, and the request is rejected. Leave them
   out and let the user set them in the WordPress admin.
6. Read the schema with `integrationSchema` before scheduling, and get the account id from
   `integrationList`.
7. After publishing, read the post back and confirm the image URLs are still in the stored
   content. If they are gone, the content was rewritten somewhere unexpected.
8. Avoid re-editing the post body in the Postiz web editor. That editor applies its own
   filtering, so a body edited there can lose the image URLs. If it has to be edited, re-check
   that every image URL is still present.
