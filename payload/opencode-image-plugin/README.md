# OpenCode image plugin payload

This directory contains the installer-managed Cloudflare image integration:

- `v2-plugin.js` is loaded by the main OpenCode V2 server.
- `SKILL.md` is installed into the main OpenCode skill directory.
- `SKILL.telegram.md` is the same guidance for the Telegram server, where the tool is
  served by the bot's MCP server and therefore named `telegram_image_generate`.

The Telegram bot's tools are no longer files: OpenCode 2.x has no tools directory, so
`image_generate`, `postiz_check_post` and `postiz_upload_image` are served by the bot's
own MCP server (`dist/mcp/server.js`, registered as `mcp.servers.telegram`).

The plugin uses Cloudflare Workers AI model `@cf/black-forest-labs/flux-2-klein-4b` and reads credentials from `CF_WORKERS_AI_ACCOUNT` and `CF_WORKERS_AI_TOKEN`.
