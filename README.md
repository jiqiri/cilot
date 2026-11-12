<p align="center">
  <img src="assets/cilot-logo.png" width="140" alt="Cilot logo">
</p>

<h1 align="center">Cilot</h1>

<p align="center">
  A Telegram agent that runs on your own machine.<br>
  Chat once, and it writes code, edits files, runs commands, makes images and schedules posts.
</p>

Cilot turns a Telegram chat into a remote control for an autonomous
[OpenCode](https://opencode.ai) agent. There is no web dashboard and no public port: the
service binds to `127.0.0.1`, and Telegram is the interface. Each chat is a real agent with a
workspace, tools, sessions and memory of its own — not a chatbot wrapper that forwards text to
an API.

It is built for one operator with a VPS, and for a small team that shares the machine without
sharing files. Every Telegram account is identified before a session exists, so what an account
can see is decided by policy, never by what the model was asked to do.

## What the agent can do

### Talk, and keep talking

- Streaming replies, with a compact mode when a long tool run would flood the chat.
- Stop a running turn, detach from a session, attach again later, rename it, and browse the
  message history.
- Switch project, switch git worktree, or start a new session, all from buttons.
- Queue a prompt while the agent is busy instead of losing it.
- Pin a session dashboard with the current agent, model, project and status.

### Work on real files

- Read, search and list files; write and edit them.
- Run shell commands when the account has that capability.
- Fetch a URL or search the web.
- Use OpenCode skills and custom commands, and connect MCP servers for extra tools.
- Switch the agent, the model and the model variant per session.

### Make images

- Generate a JPEG with Cloudflare Workers AI from a normal chat request.
- Cilot delivers it as a native Telegram photo, not a file link.
- Generated images are recorded per account, so one user cannot pull another user's image
  just by knowing its filename.

### Publish to social platforms

The bundled `postiz-social` agent is a publishing workflow, not a prompt trick:

1. `telegram_image_generate` writes the image and reports its path.
2. `telegram_postiz_upload_image` uploads it to the Postiz instance, because Postiz schedules
   posts from hosted URLs, not local files.
3. `postiz_integrationSchedulePostTool` schedules the post with that URL attached.

Before anything is scheduled, `telegram_postiz_check_post` checks the finished copy against
the destination. Social targets are plain text: no `<p>`, `<em>`, `<strong>` or Markdown image,
because the network renders none of it. Article targets such as WordPress may use markup,
because their plugin does. The rule belongs to the destination, so one run can produce a
plain Facebook post and a formatted WordPress article without a global switch.

### Automate

- Create a scheduled task with `/task` (cron-style timing, prompt, project).
- List, pause and inspect tasks with `/tasklist`.
- Tasks run through the same agent and the same workspace as a normal chat.

### Speak and listen

- Send a voice message instead of typing.
- Turn text-to-speech off, on for every reply, or on only when it adds value.

### Make it yours

- **Personas** — a library of voices with create, edit and switch. A shared "How to talk"
  block is appended to every persona so replies stay short, plain and free of tool narration.
- **Per-account settings** — agent, model, project, session, TTS, streaming and output mode
  are stored per Telegram id, so two people on one bot never move each other's state.
- **13 interface languages** — including Vietnamese, with more added by dropping one file.

### Share a machine, not files

- **Admin** — the first id in `TELEGRAM_ADMIN_USER_IDS`. Full reach only after `/access on`:
  shell-capable agents, the whole filesystem, `/vault`, server control, every project.
- **Standard account** — confined to
  `~/.local/share/tg-workspaces/users/<telegram id>/projects`, with the approved agent set
  (`social-media`, `postiz-social`) that has no `bash`, `task`, `webfetch`, `websearch` or
  `external_directory`.
- **`/user`** — Add, Block or Delete an account. Block keeps the data; Delete removes the
  workspace, settings, sessions, images and grants after a confirmation.
- **`/share`** — the only way two accounts see the same folder, granted by name and id.
- **`/vault`** — API keys and environment secrets, masked in chat and never sent to the model.

The default is the safe state: `/access off`, everything inside the account's own workspace.
`/access on` is the one command that raises the admin, and it is always reachable so a bad state
never needs SSH to undo.

## How it fits together

```
Telegram
   │
   ▼
cilot-bot.service        identifies the account, applies policy
   │  workspace + settings per Telegram id
   ▼
OpenCode server (127.0.0.1:4096)     runs the agent, owns tool permissions
   │
   ├── files        workspace, shared folders, projects, worktrees
   ├── tools        read/write/edit/bash/webfetch/websearch, skills, MCP
   └── MCP          image generation, Postiz check and upload
```

A second, separate OpenCode server on `127.0.0.1:5100` belongs to the operator and is not
reachable from Telegram. The two servers do not share configuration, which is why an agent
granted to a standard account cannot borrow the operator's tools.

## Quick start

Requirements: Linux with `systemctl` and a user session, plus a C/C++ toolchain, `make` and
`python3` for `better-sqlite3`. The installer fetches Node.js into your home directory if the
machine does not have a supported version; it never installs Node from the distribution and
never needs root.

```bash
git clone https://github.com/jiqiri/cilot.git
cd cilot
./install.sh --check        # inspect the machine, change nothing
```

Put credentials outside the repository:

```bash
mkdir -p ~/.config/cilot
cp install.env.example ~/.config/cilot/install.env
$EDITOR ~/.config/cilot/install.env
```

```bash
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_ALLOWED_USER_ID=111111111
CF_WORKERS_AI_ACCOUNT=your-account-id
CF_WORKERS_AI_TOKEN=your-api-token
```

```bash
./install.sh
```

Then open the bot in Telegram and send `/start`. The first id is the admin; `/access status`
shows the safe state, and `/access on` raises it when you need the machine rather than just the
workspace.

Full instructions — credential layout, Postiz, the two servers, upgrade and uninstall — are in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Commands

| Command | What it does |
| --- | --- |
| `/start` | Welcome, reset, start the OpenCode server (admin) |
| `/projects` | Pick a project, including the personal workspace |
| `/worktree` | Switch git worktrees of the current project (admin) |
| `/new` | Start a new session |
| `/sessions` | List sessions you own |
| `/messages` | Browse the current session's messages |
| `/rename` | Rename the current session |
| `/abort` | Stop the current turn |
| `/detach` | Detach from the session |
| `/model` | Choose model and variant |
| `/persona` | Switch or manage the assistant's voice |
| `/settings` | Streaming, compact mode, TTS, pinned dashboard, prompt queue |
| `/task`, `/tasklist` | Create and inspect scheduled tasks |
| `/commands`, `/skills`, `/mcps` | Custom commands, skills and MCP servers |
| `/stop` | Stop the OpenCode server (admin, elevated) |
| `/open`, `/ls` | Browse directories and add a project (admin, elevated) |
| `/vault` | API keys and environment secrets (primary admin, elevated) |
| `/access` | Safe default on/off for the admin (primary admin) |
| `/user` | Add, block or delete accounts (primary admin, elevated) |
| `/share` | Shared folders and grants (primary admin, elevated) |
| `/status`, `/help` | Server status and the command list |

## Security posture

- The bot and OpenCode bind to loopback only; nothing listens on a public interface.
- Account identity comes from the Telegram update, not from the model. The decision happens
  in `access-control.ts` before a session is created.
- The safe default is off: the admin included, everyone starts inside
  `~/.local/share/tg-workspaces/users/<id>/projects`.
- Path checks compare `realpath`, so `..` and symlinks cannot escape the workspace.
- Blocked ids are refused at the auth middleware, before any handler runs.
- Secrets live in mode-`600` files and are redacted from logs and replies.
- The known limit is documented rather than hidden: the bot and the OpenCode server share one
  Linux user, so isolation is enforced at the application and agent layer. A standard agent
  that gained `bash` would break it, which is why the standard agent set denies it.

Details and the full threat model: [ARCHITECTURE.md](./ARCHITECTURE.md#threat-model-and-limitations)
and [USAGE.md](./USAGE.md) (Vietnamese).

## Repository layout

```text
.
├── install.sh                  installer, check mode, service setup
├── update.sh                   update from the published branch
├── uninstall.sh                stop and remove the services
├── install.env.example         credential template (copy outside the repo)
├── ARCHITECTURE.md             internals, deployment, security boundaries
├── USAGE.md                    operator guide in Vietnamese
├── assets/cilot-logo.png
├── payload/
│   ├── cilot/                  the bot source, built with npm
│   ├── postiz-agent/           the social-publishing agent definition
│   └── personas/               starter persona templates
└── tools/                      installer helpers
```

## Credits

Cilot is a fork of [`@grinev/opencode-telegram-bot`](https://github.com/grinev/opencode-telegram-bot),
built on [OpenCode](https://opencode.ai). The upstream project and this fork are MIT licensed;
see [LICENSE](./LICENSE).
