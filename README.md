# OpenCode Telegram Installer

A Linux user-level installer for:

- OpenCode V2 (`2.0.11`) on `127.0.0.1:5100`
- An isolated OpenCode `1.18.32` server for the Telegram bot on `127.0.0.1:4096`
- The current `opencode-telegram-bot` source, built with npm
- A Cloudflare Workers AI `image_generate` tool for both OpenCode servers
- User systemd services for OpenCode and the Telegram bot

The installer does not require root. It installs into the current user's home directory and enables user
services. Root, or passwordless `sudo`, is only needed to install `curl` and `tar` when the machine is
missing them.

## Requirements

Linux with `systemctl` and a user session. That is the whole list.

Check a machine before installing anything:

```bash
./install.sh --check
```

It reports the account, each required tool, the native toolchain, the user systemd session and
whether sudo works, without modifying the machine. Useful on a locked-down host where you need
to know in advance whether the install can complete.

## If you cannot install system packages

**A native C/C++ toolchain is mandatory, and there is no unprivileged workaround.**

`better-sqlite3` is a hard dependency of the bot. Its current release ships no prebuilt
binaries — the `v13.0.1` GitHub release has zero binary assets, and the package has no
`prebuild-install` dependency. Its install script is literally `node-gyp rebuild`, so `npm ci`
compiles it from source. The bot imports it with a static top-level import, so a missing
binding crashes the process at startup rather than degrading. `npm ci --ignore-scripts` is
therefore not a way out.

If your account is not in the `sudoers` file, one of these has to happen:

| Option | Command |
| --- | --- |
| An administrator installs it | `sudo apt-get install -y build-essential python3` |
| Start from an image that has a compiler | Debian, Ubuntu, Fedora and Arch images normally do |
| Build on a machine that has one | Install there, then copy the finished tree |

The installer will not try to download a compiler into your account. Dropping a private
toolchain into `$HOME` to route around a machine policy is not something it should do on its
own; if you need that, `zig` works as a drop-in `cc` and `c++`, and you would still need
`make` and `python3`.

The full list per distribution, and why each is needed, is in the error the installer prints
when it detects the problem.

The installer installs what it can:

- `curl` and `tar` come from your package manager if missing. Without `curl` it falls back to
  `wget` to bootstrap the rest, and only fails outright if neither can be obtained.
- **A C/C++ toolchain, `make` and `python3`** are installed the same way if absent. The bot
  depends on `better-sqlite3`, whose install script is exactly `node-gyp rebuild` with no
  prebuilt-binary fallback, so `npm ci` cannot complete without them.
- **Node.js is downloaded from nodejs.org into `~/.local/share/opencode-telegram-installer/bin`**
  when the machine has no Node, or has one older than the `^22.14.0 || ^23.6.0 || >=24` engine
  the bot declares.

Node is deliberately *not* installed from the distribution. Debian 12 ships Node 18 and Ubuntu
22.04 ships Node 12, so `apt install npm` would usually succeed and then fail much later with a
confusing TypeScript build error. The tarball needs no root, does not modify the system, and
matches how the OpenCode binaries are already installed. Override the version with
`NODE_VERSION=24.1.0 ./install.sh`.

Run the installer as your normal user, never as `sudo ./install.sh`. Everything installs into
your own home and registers *user* systemd services; under sudo, `HOME` becomes `/root` and the
units would belong to the wrong account. The installer refuses to run as root and says so.

Package installs are the only step that needs privilege, and they use `sudo -n`. So:

| Situation | What happens |
| --- | --- |
| Passwordless sudo works | Packages install automatically, no prompt. |
| sudo needs a password | `sudo -n` fails immediately, the installer prints the exact command to run, and stops. It never blocks on an invisible prompt. |
| No sudo at all | Same: instructions are printed. |

To check which case you are in:

```bash
sudo -n true && echo "passwordless sudo works" || echo "sudo needs a password"
```

If it needs a password, install the two sets yourself and re-run the installer normally:

```bash
sudo apt-get install -y curl tar ca-certificates openssl build-essential python3
./install.sh
```

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

### Personas are personal data

Personas live in two places, and only one of them is in this repository:

| Path | Contents | In git? |
| --- | --- | --- |
| `payload/personas/*.md` | Starter templates shipped to a new install | Yes, version controlled |
| `~/.config/opencode-telegram-server/opencode/personas/*.md` | Your actual library, edited by the bot | No, outside any repo |
| `~/.config/opencode-telegram-server/opencode/PERSONA.md` | The active persona, rewritten on every switch | No, mode `600` |

The live library is not a git repository, so there is nothing to ignore. Editing a persona with
`/persona` → Edit text, or creating one with Create, only ever touches the live path. Do not
edit `payload/personas/` for personal changes: that directory is the seed, and everything in it
is pushed to the repository.

The installer is deliberately non-destructive here. It only adds starter templates that are
missing, and it creates `PERSONA.md` only when absent, so re-running it cannot overwrite an
edited persona or reset the active voice.

The main V2 server at `~/.config/opencode` uses the same persistent `image_generate` plugin
but does not get the Postiz tools.


### Hiding a project

`/projects` lists directories that the OpenCode server has sessions for, merged with a local
cache of directories the bot has seen. It is derived state, not configuration, and there is no
list to edit.

Two ways to make a project disappear from the menu:

- `PROJECTS_EXCLUDED_PATHS` in the bot `.env`, comma separated. The shipped default is `/`,
  because that is the OpenCode server's working directory and it would otherwise offer the
  whole filesystem as a project.
- `🗑 Hide a project` at the bottom of the `/projects` menu, which stores the path in
  `settings.dismissedProjects` in `settings.json`.

Both are applied when the list is read, in `getProjects()`. Neither deletes the session cache
entry, and that is deliberate: `warmupSessionDirectoryCache()` re-ingests from the sqlite
database and the global session storage on every OpenCode-ready refresh, so a removed entry
reappears within seconds. Filtering at read time is the only durable approach, and it deletes
nothing.

To bring a hidden project back, remove its path from whichever of the two holds it.

## Translations

Every user-facing string in the Telegram bot goes through `t("key")` and lives in
`payload/opencode-telegram-bot/src/i18n/<locale>.ts`. `en.ts` is the source of truth and defines
the `I18nKey` union; every other file is typed as `I18nDictionary = Record<I18nKey, string>`.

That type is the guard. If a locale is missing a key, `npm run build` inside the bot package
fails with the key name:

```
error TS2741: Property '"persona.button.back"' is missing in type '{ ... }'
              but required in type 'I18nDictionary'.
```

So a new feature cannot ship with a locale silently missing strings. When you add a key to
`en.ts`, add it to all other locales too, seeded with the English text, and let translators
fill them in.

### Adding a language

1. Copy `src/i18n/en.ts` to `src/i18n/<code>.ts`.
2. Translate every value. Leave `{placeholders}` exactly as they are, including the name.
3. Register it in `src/i18n/index.ts`: add the import and an entry in `LOCALE_DEFINITIONS`
   with `code`, `label`, and a BCP 47 `dateLocale`. Keep the array alphabetical by `code`.
4. Add the code to the supported-locale comment in `.env.example`.
5. Activate with `BOT_LOCALE=<code>` and restart the bot.

### Checking coverage

```bash
node tools/i18n-status.mjs                 # coverage table for every locale
node tools/i18n-status.mjs --locale vi     # list what vi still has in English
node tools/i18n-status.mjs --locale vi --all
```

No dependencies, so a translator can run it without installing anything. A non-zero `missing`
column means the build is currently broken for that locale.

Two caveats on the numbers. A value identical to English is counted as untranslated, which is
correct for most keys but wrong for pure placeholders such as `📊 {used} / {limit} ({percent}%)`
or technical tokens like `Cron:` and `PID:`. And coverage counts keys, not quality: 96% can
still hide a mistranslation. Vietnamese currently sits at 554/576, of which 4 are identical by
design.

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
