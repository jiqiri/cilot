# OpenCode Telegram Installer

A Linux user-level installer for:

- OpenCode V2 (`2.0.11`) on `127.0.0.1:5100`
- An isolated OpenCode `2.2.5` server for the Telegram bot on `127.0.0.1:4096`
- The current `opencode-telegram-bot` source, built with npm
- The Telegram tools (`image_generate`, `postiz_check_post`, `postiz_upload_image`) served
  by the bot's own local MCP server, plus a Cloudflare Workers AI `image_generate` plugin
  for the main OpenCode server
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
2. Put your credentials in `install.env`, created outside the repository at `~/.config/opencode-telegram-installer/install.env`. A fresh install writes this file for you, but you can create it first:

```bash
mkdir -p ~/.config/opencode-telegram-installer
cp install.env.example ~/.config/opencode-telegram-installer/install.env
$EDITOR ~/.config/opencode-telegram-installer/install.env
```

```bash
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_ALLOWED_USER_ID=111111111
CF_WORKERS_AI_ACCOUNT=your-account-id
CF_WORKERS_AI_TOKEN=your-api-token
```

Add these too if you use the optional Postiz MCP server:

```bash
POSTIZ_MCP_URL=https://postiz.example.com/api/public/v1/mcp
POSTIZ_MCP_TOKEN=your-bearer-token
```

Replace `POSTIZ_MCP_URL` with an absolute `http://` or `https://` endpoint and set the matching token. When both values are set, the installer adds Postiz to both OpenCode configurations and loads the token from a mode-`600` environment file. Leave both empty to skip Postiz; setting only one is rejected.

Editing `install.sh` itself still works and is still checked by the installer, but it is the reason `git pull` used to conflict with your credentials. See [Settings and credentials](#settings-and-credentials) to change where they are read from.

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

## Settings and credentials

Credentials are read from a file, not from `install.sh`, and the file lives **outside the repository**, at `~/.config/opencode-telegram-installer/install.env`.

Outside matters because the repository is disposable. Re-cloning into a new directory is the normal way to pick up a fix, and anything stored inside the checkout is destroyed by that. A file inside the repo also means `git pull` can conflict with your own tokens.

Looked for in this order, first match wins:

1. the environment, so `TELEGRAM_BOT_TOKEN=... ./install.sh` overrides the file
2. `--env-file PATH`, or the `INSTALL_ENV_FILE` environment variable
3. `~/.config/opencode-telegram-installer/install.env`
4. `./install.env`, if you keep it in the checkout
5. the placeholders at the top of `install.sh`, which then fail and name the value that is missing

The file is plain `KEY=value` lines and is sourced, so quotes and spaces work. The installer creates it with mode `600` after a successful first run, seeded from whatever it used, and **never overwrites an existing one**, so your edits stay yours.

A normal update is just:

```bash
git pull
./install.sh
```

No credentials re-entered, no merge conflict, and the settings survive a re-clone.

If you have an older `install.env` sitting in the checkout, move it out:

```bash
mkdir -p ~/.config/opencode-telegram-installer
mv install.env ~/.config/opencode-telegram-installer/install.env
```

The installer does this for you on the next run, and says so, but only when the new location does not already exist. A file named explicitly with `--env-file` is left where it is.

To put the file somewhere else entirely, name the path:

```bash
./install.sh --env-file /somewhere/else/settings.env
```

`./install.sh --no-settings-file` skips writing the file on first run, for machines that supply everything through the environment.

### The /vault menu

`/vault` is where provider keys and env secrets are entered, so a credential never has to be
typed into a prompt, pasted into a config file in the repository, or committed.

It is visible only to the **first** id in `TELEGRAM_ADMIN_USER_IDS`. A later admin can
restart services but cannot read the vault: it holds credentials for every account on the
machine. Values are masked in the menu, the message that carried them is deleted after it is
read, and they are never sent to the model.

Two kinds of secret are stored differently:

| Kind | Stored as | Takes effect |
| --- | --- | --- |
| Provider key | written through the server's integration API | immediately |
| Env secret | `~/.config/opencode-telegram-server/secrets.json` (mode `600`), rendered to `secrets.env` (mode `600`) | after the button that restarts `opencode-telegram-server.service` is pressed |

The restart is a button rather than automatic so a half-entered set of secrets never reaches
a running server. The installer writes `SECRETS_FILE` and `SECRETS_ENV_FILE` to
`opencode-telegram-server.env`, which both units load, and `OPENCODE_SERVER_UNIT` to the bot's
`.env`; the server unit loads `secrets.env` with an optional `EnvironmentFile` so the first
install works before any secret exists.

## Installed paths

By default:

```text
~/.opencode/bin/opencode
~/.opencode-telegram/bin/opencode
~/.local/share/opencode-telegram-installer/opencode-telegram-bot
~/.config/opencode/plugins/cloudflare-image/index.js
~/.config/opencode-telegram-server/opencode/opencode.jsonc   # registers mcp.servers.telegram
~/.config/opencode-telegram-server/opencode/AGENTS.md
~/.config/opencode-telegram-server/opencode/agents/postiz-social.md
~/.config/opencode-telegram-server/opencode/skills/postiz-guidance/SKILL.md
~/.config/opencode-telegram-server/secrets.json              # /vault store, mode 600
~/.config/opencode-telegram-server/secrets.env               # rendered for the server unit, mode 600
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

`telegram_image_generate` (Cloudflare Workers AI) generates the JPEG and saves it to disk,
returning the absolute path in its output text. Postiz schedules posts with
`postsAndComments[].attachments` as an array of hosted HTTPS URLs, so a local file cannot be
attached directly. The sequence is:

1. `telegram_image_generate` -> reports the saved `localPath`
2. `telegram_postiz_upload_image` with that `localPath` -> returns a hosted `path`
3. `postiz_integrationSchedulePostTool` with that `path` in `attachments`

The `telegram_` prefix is the MCP server name: these three tools come from the bot's local
MCP server, not from a `tools/` directory. The agent prompts and skills use those names; the
bot's own event handling still keys off the V1 names through the adapter.

`telegram_postiz_upload_image` exists because the Postiz MCP surface only exposes
`uploadFromUrlTool(url)`, which makes Postiz fetch a **public** URL itself. Locally generated
files have no public URL and there is no inbound port, so the upload goes through the Postiz
public API at `POST $POSTIZ_API_URL/public/v1/upload` instead.

Because the tool reads files itself, it does not go through OpenCode's `read` permission.
It is confined to `POSTIZ_UPLOAD_ALLOWED_ROOTS`, and a file in the shared
`opencode-generated-images` directory is refused unless the same MCP process wrote it: each
workspace gets its own process, so one account cannot publish another account's image.

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

## Social post formatting

How much markup a post may carry is a property of **where it is going**, not a preference you
set once.

**Social platform copy is plain text, with no markup.** No `<p>` around paragraphs, and no
`<em>`, `<strong>`, `<b>`, `<i>` or `<u>` to stress a word. Paragraphs are separated by a
blank line.

The emphasis tags are the ones that catch people out. `<em>really</em> important` is a habit,
not formatting: a social network renders none of it, so the reader either sees the tag or
loses the emphasis entirely. The way to stress a word in plain text is the sentence, not the
markup. `This matters more than it looks` beats `<em>This matters</em>`.

**Article targets such as WordPress may use markup**, because the site's plugin turns a bare
image URL sitting inside its own paragraph into a rendered image. `<p>`, `<h1>`-`<h3>`,
`<strong>`, `<u>`, `<ul>`, `<li>` are fine there.

That is why this is per platform rather than one switch. A single global setting had to be
either permissive, which let `<em>` through to Facebook, or strict, which broke the WordPress
image rule. As a property of the destination, a plain-text Facebook post and a
`<p>`-formatted WordPress post can be produced in the same run with nothing to reconcile.

`telegram_postiz_check_post` enforces it. Run on the finished `content` of every post and every
comment, it reports HTML tags, inline emphasis tags by name, Markdown images, `<u>` overlapping
`<strong>`, and anything over the platform's `maxLength`, counting visible characters rather
than markup. It tells you which rule it applied:

```
Checked the content field for facebook in strict mode (plain text only on this target).
ERROR: 4 HTML tag(s) (em, strong) found. facebook post copy is plain text, so these
are not formatting here: they are either stripped or published as visible text.
You used <em>, <strong> to stress a word; a social network renders none of it.
Get the emphasis from the sentence instead. Remove every tag and rewrite.
```

To loosen both cases, in `~/.config/opencode-telegram-installer/install.env`:

```bash
POSTIZ_CONTENT_FORMAT=html
```

`strict` is the default and the only other accepted value. `plain` is still accepted as a
former name for `strict`, so a settings file written earlier keeps working. Edit the file,
re-run `./install.sh`, restart the bot; the value is read at runtime and needs no rebuild.

This is a check, not a fence. The tool is something the agent chooses to call, so a determined
failure to call it remains possible. If you need a hard guarantee rather than a very large
reduction, enforce it at the Postiz instance or in the agent's own wrapper rather than in the
prompt.

## Persona output rules

A persona file only describes a voice. On its own it does not change how the model handles
formatting, so the default framing stays in charge: a terminal tool narrating the commands it
is about to run, opening with "Great question", closing with a menu of next steps, and writing
wall-sized answers into a chat window.

Every persona therefore gets a shared **How to talk** block appended to `PERSONA.md` when it is
materialised: no tool narration, no restating the question, no closing menu, short messages,
plain paragraphs instead of tables, a one-sentence description of failures, and an answer in
the language you wrote in. The persona text comes first, so it sets the tone and the block
covers the mechanics.

The block is added by the installer of the persona rather than by the persona author, so a
persona you write yourself gets it too, and switching personas cannot drop it. Clear the active
persona and the overlay is emptied entirely, leaving the model on its default voice.

## Architecture

```
Telegram
  │
  ▼
opencode-telegram-bot.service          grammy; decides who you are and what you may do
  │  access-control.ts → policy: deny | standard | admin
  │  per-account state in settings.json, keyed by Telegram id
  │  realpath containment for every path it hands to OpenCode
  ▼
opencode-telegram-server.service      opencode 2.2.5 on 127.0.0.1:4096
  │  enforces tool permissions itself: bash, edit, external_directory, MCP
  │  agents: social-media (restricted), postiz-social, build, plan, …
  │  MCP servers: telegram (image_generate, postiz_check_post, postiz_upload_image), postiz
  ▼
LLM provider

owner's own interactive use → opencode.service   opencode 2.0.11 on 127.0.0.1:5100
```

Three user-level systemd services under one Linux user. No containers.

## Why two OpenCode servers

Both run the 2.x API, but they are separate installations with separate binaries, config
trees and ports: 2.0.11 serves the owner's own interactive work, and the bot never talks to
it.

The bot used to require `1.18.32` because it called the root-level endpoints (`/session`,
`/project`, `/event`, …), which 2.x replaced with `/api/*`, and because 2.x has no `tool`
config key to load the three TypeScript tools from disk. Both gaps are closed in the bot:

- `OPENCODE_API_FLAVOR=v2` switches the client to the `/api/*` surface and adapts the
  responses and events back to the shapes the Telegram UI already understands.
- The three tools are served by a local stdio MCP server (`dist/mcp/server.js`, registered
  as `mcp.servers.telegram` with `"codemode": false`). OpenCode names them
  `telegram_image_generate`, `telegram_postiz_check_post` and
  `telegram_postiz_upload_image`; the adapter maps them back to the V1 names for the bot,
  while the agent prompts and skills use the MCP names.

`"codemode": false` is required: with the default, OpenCode only exposes an MCP server's
tools inside a `tools.<server>.*` sandbox, and a direct call fails.

## Telegram roles

| Telegram id | Policy | Workspaces | Agents | Admin commands |
| --- | --- | --- | --- | --- |
| not configured | **denied** | — | — | — |
| in `TELEGRAM_ALLOWED_USER_ID(S)` | standard | own only | `social-media`, `postiz-social` | no |
| in `TELEGRAM_ADMIN_USER_IDS` | admin | all | any the server offers | yes |

Unknown ids get nothing. Adding a user is a deliberate edit, not a side effect of the bot
being reachable. An id in both lists is admin.

```bash
# ~/.config/opencode-telegram-installer/install.env
TELEGRAM_ALLOWED_USER_ID=111111111,222222222   # standard accounts
TELEGRAM_ADMIN_USER_IDS=999999999              # admin
OPENCODE_TELEGRAM_CONFINE_ADMINS=false         # true: admin stays inside its own folder
```

The decision happens in `access-control.ts`, before a session is created or selected, and
never involves the model. Command menus are filtered per policy, and admin-only commands are
refused at dispatch rather than merely hidden.

`OPENCODE_TELEGRAM_CONFINE_ADMINS=true` keeps the admin policy's agent and command power
but drops cross-account reach: sessions, projects, images and the `/open` browser are limited
to `OPENCODE_TELEGRAM_USER_ROOT/<id>`, the same boundary a standard account gets. It is off
by default because a single-operator install normally expects to see the whole machine.

## User isolation

| Layer | What it guarantees |
| --- | --- |
| `access-control.ts` | who an id is, and which capability each action needs |
| `sessions.json` ownership | an account can only open sessions it owns; checked at the point of use, not when listing |
| project authorization | narrowed in the application, because OpenCode's `/project` ignores `directory` and answers globally |
| realpath containment | `..` and symlinks cannot leave a root; the string-prefix version was the bug |
| per-account workspace | `OPENCODE_TELEGRAM_USER_ROOT/<telegram id>/projects` |
| personal project | created on demand and shown in `/projects`, so a standard account can use `/new` before the server knows the directory |
| OpenCode permissions | `bash`, `edit` outside the workspace, `webfetch` and `external_directory` are **denied in the server**, not requested in a prompt |
| image ownership | every generated file is recorded per account and re-checked on every read and send |
| `telegram_postiz_upload_image` | confined to `POSTIZ_UPLOAD_ALLOWED_ROOTS`, and a shared-directory file must have been written by the same MCP process; it does its own read, which OpenCode does not cover |

A restricted account has no shell, so the workspace boundary is a real boundary rather than a
convention. Admins are trusted in this model and are not confined to their own workspace
unless `OPENCODE_TELEGRAM_CONFINE_ADMINS=true` is set. Even then, confinement covers the
bot's own paths and project/session selection; an agent with `bash` still runs as the Linux
user and can read whatever that user can read. Use a separate Linux account or a container
when the shell itself must be contained.

## The social-media agent

`social-media` is granted to standard accounts. It is deny-by-default, then re-opens exactly
what the workflow needs:

| Capability | Decision |
| --- | --- |
| `postiz_*` (the whole Postiz MCP namespace) | allow |
| `telegram_image_generate`, `telegram_postiz_check_post`, `telegram_postiz_upload_image` | allow |
| `read`, `glob`, `grep`, `list` | allow |
| `write`, `edit` (own workspace only) | allow |
| `question` | allow |
| `bash`, `task`, `webfetch`, `websearch` | **deny** |
| `external_directory` | **deny** |
| anything not listed | **deny** |

Image reading and generation are preserved, which was a requirement: the restriction is on
capability, not on media.

The Postiz tools are granted as the `postiz_*` **namespace**, not enumerated. Adding another
integration, a `zapier_` MCP server for instance, is a configuration change in OpenCode plus
one line in the agent, and needs no change in the Telegram application. There is no second
MCP authorization framework: OpenCode owns tool execution and its permission system.

### Changing or adding an agent

Agent definitions are markdown with a `permission` map in the frontmatter, in
`payload/postiz-agent/agents/`, installed into
`~/.config/opencode-telegram-server/opencode/agents/`. They are static and role-based; no
agent is created per user. Entries declared there are **appended** to OpenCode's own defaults
and evaluated last-match-wins, which is the same mechanism the built-in `plan` agent uses.

`permission` is a map, not a list:

```yaml
permission:
  "*": deny
  "postiz_*": allow
  "bash": deny
```

To add a user-visible agent, drop a markdown file there and add its name to `STANDARD_AGENTS`
in `access-control.ts` if standard accounts should be able to select it.

## Images

Generated JPEGs go to `$XDG_DATA_HOME/opencode-generated-images/`, the filenames are chosen
by the model, and the bot records who produced each one. Knowing a filename is therefore not
permission: a standard account is refused another account's file, and an admin may read across
accounts because that is an explicit grant. The file is sent to Telegram as a buffer, never by
uploading the path.

## Threat model and limitations

Fixed in 0.26.0: cross-account session reads, global project listing, symlink and traversal
escape, unrestricted social agent, arbitrary file read through the upload tool, missing roles,
indirect access to excluded projects, shared persona overlay, unowned generated images,
unauthorized agent and MCP selection. See `CHANGELOG.md` for the reproductions.

Not covered, deliberately or because it is out of reach here:

- **Admins are trusted.** An admin id can reach anything the Linux user can, including
  configuration and credentials. Keep the admin list short and to people who would have shell
  access anyway.
- **One Linux user, no containers.** Isolation is by directory and by OpenCode's permissions,
  not by the kernel. If a restricted account could reach a shell, the directory boundary would
  not hold. It cannot, because `bash` is denied in the server.
- **MCP servers are as trusted as their tools.** Granting `zapier_*` to an agent grants every
  tool that server exposes. Review what a server can do before granting its namespace.
- **OpenCode's runtime enforcement is not exercised by the tests.** The deny-by-default block
  is verified at the configuration and resolution layer against a running server; a live tool
  call was not, because the configured provider refuses out-of-process requests.
- **A model that is being lied to** can still be talked into trying. The boundaries above are
  not prompt-based, so a successful attempt ends in a permission refusal rather than an action.
- **Secrets remain in the OpenCode server's environment**, reachable by anything that can run
  code there. A restricted account cannot, an admin can.

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

## Updating

```bash
./update.sh --check      # is there a newer release? changes nothing
./update.sh              # update, then restart the bot
./update.sh --no-restart # update, leave the running service alone
```

Installed machines get the same script at `~/.local/share/opencode-telegram-installer/update.sh`, so it can be run from anywhere.

The script does the work itself instead of delegating to the bot's `update` subcommand, because that subcommand only exists from this release onwards. Delegating would make the first update impossible on any machine installed before it. The bot's own `opencode-telegram update [--check]` remains available once updated, and does the same work without restarting the service.

Change detection compares a fingerprint of the tracked source files, not the bot's version number. The payload also carries personas, skills, agent guidance and tools, and those change without `package.json` moving, so a version comparison would skip most published updates. `npm ci` and the build only run when the dependency set actually changed, so a routine update that touches one file is a file copy rather than a five minute install.

**Your settings are preserved.** `.env`, `settings.json` and `settings.json.bak` are copied aside and put back, so the Telegram token, the OpenCode credentials, and per-account state (persona, project, session, hidden projects, scheduled tasks) all survive. `dist/` and `node_modules/` are removed first so stale build output cannot survive an update. If the download or the build fails, the previous installation keeps running.

### Updates come from your repository, not upstream

The bot package itself is vendored from `grinev/opencode-telegram-bot`, and that is *not* where updates come from. `install.sh` records where it actually fetched the payload from:

```text
~/.local/share/opencode-telegram-installer/payload-source.txt
```

Both `update.sh` and `opencode-telegram update` prefer that file, so a machine installed from your fork updates from your fork. The URL compiled into the bot is only a last resort, and it warns when it falls back to it.

To install from your own fork, set these at the top of `install.sh` before running it:

```bash
PAYLOAD_REPO="your-org/your-fork"
PAYLOAD_BRANCH="main"        # or your branch
```

After the first install, `payload-source.txt` follows that fork, and so does every later update. Check it at any time with `cat ~/.local/share/opencode-telegram-installer/payload-source.txt`.

One-off override, without changing the recorded source:

```bash
OPENCODE_TELEGRAM_UPDATE_URL=https://github.com/other/repo/archive/refs/heads/main.tar.gz ./update.sh
```

## Adding another Telegram user

Each account gets its own project, session, agent, model, persona, hidden projects, settings and scheduled tasks. A second account cannot see or resume the first account's conversations.

1. Get the new id from [@userinfobot](https://t.me/userinfobot). It is the number, not the username.
2. List every permitted id in `install.env`, comma separated, first one being the primary account. Either variable works, and if you set both they are merged in that order. An id not listed here, and not in `TELEGRAM_ADMIN_USER_IDS`, is denied:

   ```bash
   TELEGRAM_ALLOWED_USER_ID=111111111,987654321
   ```

3. Re-run the installer and restart the bot:

   ```bash
   ./install.sh
   systemctl --user restart opencode-telegram-bot.service
   ```

The first id is the **primary account**. It is used for startup session restore, and it adopts the sessions that already exist so nothing is lost when you add a second account. Later accounts start empty and only ever see what they create.

`TELEGRAM_ALLOWED_USER_ID` takes one id or a comma separated list, and `TELEGRAM_ALLOWED_USER_IDS` is equivalent. They are merged rather than one overriding the other, so an id listed in either file is permitted, and the first id overall is the primary account.

> Adding an id grants that person the bot's full capabilities: shell access and file read/write as the Linux user running it, plus the OpenCode server and the Postiz and Cloudflare credentials in its environment. Only add people you would give that access to directly.

## Verify

```bash
opencode plugin list
systemctl --user status opencode.service
systemctl --user status opencode-telegram-server.service
systemctl --user status opencode-telegram-bot.service
```

The Telegram-side OpenCode server should list the three `telegram_*` tools among its tools. From Telegram, start a new session and request an image, for example:

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
