---
name: Postiz Publishing
description: Attach locally generated images to Postiz social posts. Covers the generate then upload then attach sequence and the schedulePost payload.
metadata:
  opencode/autoinvoke: true
---

Read this before creating a Postiz post that carries an image.

## The constraint

`image_generate` (Cloudflare Workers AI) generates the image and saves it to disk. It
returns an absolute `localPath`.

Postiz schedules posts with hosted URLs only:

```
postsAndComments[].attachments: string[]   // https:// URLs
```

A local path is not a URL. A `data:` URI is not a URL. The image has to be uploaded into the
Postiz media library before it can be attached.

## Why there is a separate upload step

The Postiz MCP surface exposes exactly eleven tools, and the only upload among them is
`uploadFromUrlTool(url)`, which makes **Postiz fetch a public URL itself**. It rejects
private addresses, localhost, and anything not publicly resolvable over HTTPS. A file on this
machine has no public URL, and there is no inbound port.

There is no MCP tool that accepts raw bytes or a local path, so the upload goes through the
Postiz public API instead. That is what `postiz_upload_image` does.

## The sequence

1. `image_generate` with platform-appropriate dimensions. Read `localPath` from the output.
2. `postiz_upload_image` with `{ "path": "<localPath>" }`. It returns `id` and a hosted `path`.
3. `postiz_integrationSchedulePostTool` with that `path` in `attachments`.

`postiz_upload_image` returns a public `https://` URL, so `postiz_uploadFromUrlTool` is not
needed and would be wrong here — it would try to fetch the file again from a host that
cannot reach it.

## Order of operations

```
postiz_integrationList
  -> postiz_integrationSchema(platform, isPremium)
  -> postiz_integrationSchedulePostTool   (text only, no image)

or, with an image:

postiz_integrationList
  -> postiz_integrationSchema(platform, isPremium)
  -> image_generate
  -> postiz_upload_image
  -> postiz_integrationSchedulePostTool
```

`postiz_integrationSchema` is not optional. Without it you are guessing at `settings` keys
and character limits.

## Payload checklist

```jsonc
{
  "socialPost": [{
    "integrationId": "<id from integrationList>",
    "isPremium": false,
    "date": "<UTC ISO 8601>",
    "type": "draft",              // only "now"/"schedule" on explicit instruction
    "shortLink": false,
    "settings": [{ "key": "<from integrationSchema>", "value": "<id preferred over label>" }],
    "postsAndComments": [
      { "content": "plain text body, blank line between paragraphs", "attachments": ["<path>"] },
      { "content": "first comment, also plain text", "attachments": [] }
    ]
  }]
}
```

- First `postsAndComments` entry is the post. Every entry after it is a comment.
- Only send the entries you need.
- `attachments` entries must be the `path` string returned by `postiz_upload_image`.
- `content` is **plain text for a social platform**. No tags: not `<p>`, and not `<em>`,
  `<strong>`, `<b>`, `<i>` or `<u>` used to stress a word. Paragraphs are separated by a
  blank line. A social network renders none of that markup, so the tag is either stripped
  or shown to the reader.
- `content` for an **article target such as WordPress** may use `<p>` per paragraph, plus
  `<h1>`-`<h3>`, `<strong>`, `<u>`, `<ul>`, `<li>`. That is the site's image-in-paragraph
  rule, not a general licence to use markup.
- Run `postiz_check_post` on the finished `content` of every entry, including comments, with
  the platform and `maxLength`, before scheduling. It applies this per-platform policy, so it
  is what makes the rule enforceable rather than merely stated. Do not schedule anything it
  marks as failed.

## Unavailable tools

`postiz_generateImageTool` is unusable on this instance. It requires an AI provider key
configured in Postiz settings and returns `500 AI generation failed` with an empty model.
Never plan a workflow around it.

## WordPress specifics

`settings.type` is interpolated directly into the endpoint:

```
${domain}/wp-json/wp/v2/${settings.type}
```

So it is the plural REST base. `posts` for blog posts, `pages` for pages. The singular `post`
produces `wp-json/wp/v2/post` and a 404 `rest_no_route`, with no correction step. Use the
`postTypes` trigger tool and pass back the `id` it returns.

`categories` and `tags` are read, coerced with `Number()`, filtered for `NaN`, and forwarded to
WordPress when non-empty. Use `categoriesList` and `tagsList` to get real numeric IDs.

`title` is required with a minimum length of 2. `status` is one of `publish`, `draft`,
`pending`, `private` and defaults to `publish` when absent. The slug is generated from the
title.

`main_image.path` is fetched and re-uploaded to `wp-json/wp/v2/media` by the provider, and the
resulting media id becomes `featured_media`. The `id` field in `main_image` is required by the
schema but is not read by the provider; `alt` is not forwarded either.
