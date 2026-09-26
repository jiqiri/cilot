# OpenCode Telegram Installer

A Linux user-level installer for:

- OpenCode V2 (`2.0.11`) on `127.0.0.1:5100`
- An isolated OpenCode `1.18.32` server for the Telegram bot on `127.0.0.1:4096`
- The current `opencode-telegram-bot` source, built with npm
- A Cloudflare Workers AI `image_generate` tool for both OpenCode servers
- User systemd services for OpenCode and the Telegram bot

The installer does not require root. It installs into the current user's home directory and enables user services.

## Requirements

- Linux with `systemd --user`
- `bash`, `curl`, `tar`, `npm`, `node`, and `openssl`
- Node.js `22.14+`
- A Telegram bot token
- Your Telegram numeric user ID
- A Cloudflare account ID and an API token with Workers AI permission
- Optional Postiz MCP URL and bearer token

## Usage

1. Download this repository, or download only `install.sh`; when the local `payload/` directory is absent, the script downloads the matching repository payload automatically.
2. Edit the placeholders near the top of `install.sh`:

```bash
TELEGRAM_BOT_TOKEN="REPLACE_WITH_TELEGRAM_BOT_TOKEN"
TELEGRAM_ALLOWED_USER_ID="REPLACE_WITH_TELEGRAM_ALLOWED_USER_ID"
CF_WORKERS_AI_ACCOUNT="REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID"
CF_WORKERS_AI_TOKEN="REPLACE_WITH_CLOUDFLARE_API_TOKEN"
```

If you also use the optional Postiz MCP server, add these variables before running:

```bash
POSTIZ_MCP_URL="REPLACE_WITH_POSTIZ_MCP_URL"
POSTIZ_MCP_TOKEN="REPLACE_WITH_POSTIZ_BEARER_TOKEN"
```

Replace `POSTIZ_MCP_URL` with an absolute `http://` or `https://` endpoint and set the matching token. When both values are replaced, the installer adds Postiz to both OpenCode configurations and loads the token from a mode-`600` environment file. Leave both placeholders unchanged to skip Postiz; setting only one is rejected.

The model defaults are:

```bash
OPENCODE_MODEL_PROVIDER="opencode"
OPENCODE_MODEL_ID="space-bunny-free"
```

3. Run:

```bash
./install.sh
```

The script validates placeholders before writing credentials. Secrets are written with mode `600` and are not printed. It does not create a public listener; both OpenCode servers bind to `127.0.0.1`.

## Installed paths

By default:

```text
~/.opencode/bin/opencode
~/.opencode-telegram/bin/opencode
~/.local/share/opencode-telegram-installer/opencode-telegram-bot
~/.config/opencode/plugins/cloudflare-image/index.js
~/.config/opencode-telegram-server/opencode/tools/image_generate.ts
~/.config/opencode-telegram-server/opencode/tools/postiz_upload_image.ts
~/.config/opencode-telegram-server/opencode/AGENTS.md
~/.config/opencode-telegram-server/opencode/agents/postiz-social.md
~/.config/opencode-telegram-server/opencode/skills/postiz-guidance/SKILL.md
~/.config/systemd/user/opencode.service
~/.config/systemd/user/opencode-telegram-server.service
~/.config/systemd/user/opencode-telegram-bot.service
```

The generated Cloudflare credentials file is:

```text
~/.local/share/opencode-telegram-installer/opencode-cloudflare.env
```

If Postiz is enabled, its token is stored separately in:

```text
~/.local/share/opencode-telegram-installer/opencode-postiz.env
```

## Telegram agent configuration

The Telegram bot talks to its own OpenCode instance whose global config root is
`~/.config/opencode-telegram-server/opencode` (the service sets `XDG_CONFIG_HOME` to
`~/.config/opencode-telegram-server`). Edit these files to change agent behaviour:

| Purpose | File |
| --- | --- |
| Rules applied to every agent | `~/.config/opencode-telegram-server/opencode/AGENTS.md` |
| Dedicated social-publishing agent | `~/.config/opencode-telegram-server/opencode/agents/postiz-social.md` |
| Postiz workflow reference | `~/.config/opencode-telegram-server/opencode/skills/postiz-guidance/SKILL.md` |
| Cloudflare image guidance | `~/.config/opencode-telegram-server/opencode/skills/cf-image-guidance/SKILL.md` |

`postiz-social` is a `primary` agent, so it appears in the bot's agent switcher. To make it
the default, add `"default_agent": "postiz-social"` to
`~/.config/opencode-telegram-server/opencode/opencode.jsonc`. Restart the service to pick up
changes:

```bash
systemctl --user restart opencode-telegram-server.service
```

### Image attachments and Postiz

`image_generate` (Cloudflare Workers AI) generates the JPEG and saves it to disk, returning
the absolute path in `localPath`. Postiz schedules posts with
`postsAndComments[].attachments` as an array of hosted HTTPS URLs, so a local file cannot be
attached directly. The sequence is:

1. `image_generate` -> returns `localPath`
2. `postiz_upload_image` with that `localPath` -> returns a hosted `path`
3. `postiz_integrationSchedulePostTool` with that `path` in `attachments`

`postiz_upload_image` exists because the Postiz MCP surface only exposes
`uploadFromUrlTool(url)`, which makes Postiz fetch a **public** URL itself. Locally generated
files have no public URL and there is no inbound port, so the upload goes through the Postiz
public API at `POST $POSTIZ_API_URL/public/v1/upload` instead.

That endpoint uses a different auth header format than the MCP transport:

| Destination | Header |
| --- | --- |
| Postiz MCP (`$POSTIZ_MCP_URL`) | `Authorization: Bearer $POSTIZ_MCP_TOKEN` |
| Postiz public API (`$POSTIZ_API_URL`) | `Authorization: $POSTIZ_MCP_TOKEN` |

Both use the same API key. `install.sh` derives `POSTIZ_API_URL` from `POSTIZ_MCP_URL` by
stripping the trailing `/mcp` and writes all three variables to
`~/.local/share/opencode-telegram-installer/opencode-postiz.env` (mode `600`), which is
loaded by both OpenCode services.

Generated images are written to `$XDG_DATA_HOME/opencode-generated-images`, which differs per
service. Override with `OPENCODE_IMAGE_DIR`.

`postiz_generateImageTool` is intentionally unused. It needs an AI provider key configured on
the Postiz instance and returns `500` without one.

The main V2 server at `~/.config/opencode` uses the same persistent `image_generate` plugin
but does not get the Postiz tools.


## Verify

```bash
opencode plugin list
systemctl --user status opencode.service
systemctl --user status opencode-telegram-server.service
systemctl --user status opencode-telegram-bot.service
```

The Telegram-side OpenCode server should list `image_generate` among its tools. From Telegram, start a new session and request an image, for example:

```text
/new
Generate a 1200x630 featured image for an article about website performance optimization.
```

## Security

Do not commit a filled-in `install.sh`. The repository intentionally contains placeholders only. If a token was pasted into chat, logs, or a shell history, rotate it before using the installation. The PAT used to publish this repository is not needed by the installer and is never read by it.

The generated service units use `Restart=always` with a restart delay, so the main OpenCode server, Telegram-side OpenCode server, and Telegram bot are automatically restarted after crashes. User lingering is required for services to keep running after logout; the installer checks for a user systemd session and the environment currently has lingering enabled.

The stack includes an uninstaller:

```bash
./uninstall.sh
```

The default uninstall stops/disables the three user services and removes the generated service files and managed bot/runtime files, but preserves OpenCode data, configuration, and other user files. Review the script before using `--purge`; `--purge` also removes the managed OpenCode/bot configuration and data directories.

A downloaded `install.sh` uses `PAYLOAD_ARCHIVE_URL` (overridable) to fetch the repository payload when needed.

For unattended use, export the variables instead of editing the script. Environment values override the placeholders:

```bash
TELEGRAM_BOT_TOKEN='...' \
TELEGRAM_ALLOWED_USER_ID='123456789' \
CF_WORKERS_AI_ACCOUNT='...' \
CF_WORKERS_AI_TOKEN='...' \
./install.sh
```

## Uninstall

The installer does not remove existing OpenCode data automatically. Stop and disable the three user services first, then remove the installation paths after reviewing them.
