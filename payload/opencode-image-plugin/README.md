# OpenCode image plugin payload

This directory contains the installer-managed Cloudflare image integration:

- `v2-plugin.js` is loaded by the main OpenCode V2 server.
- `v1-tool.ts` is loaded by the isolated OpenCode 1.18 server used by the Telegram bot.
- `SKILL.md` is installed into both OpenCode skill directories.

The plugin uses Cloudflare Workers AI model `@cf/black-forest-labs/flux-2-klein-4b` and reads credentials from `CF_WORKERS_AI_ACCOUNT` and `CF_WORKERS_AI_TOKEN`.
