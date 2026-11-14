# Cilot add-ons — design and contract

This is the specification for Cilot's add-on system: what an add-on is, how the agent calls it,
how it is configured, who may use it, and where everything lives on disk. It is written before
the code so the contract is stable, reviewable and does not have to be reverse-engineered from
an implementation.

Status: **implemented** in **Cilot 1.1.x** with the mail add-on. §21 lists the files;
"Implementation notes" below records where the code settles a question this document left open.

The examples use a mail reader, because "read my mail, but only these labels" is the case that
forces every decision in this document: per-user data, a credential per user, a small config
surface, and a result the model has to be trusted not to widen.

### Implementation notes (1.1.0)

These are the places where the shipped code settles a detail differently from the text below.
The contract — identity from cwd, `policy.json` as the only authorization record, one MCP
process per add-on — is unchanged.

- **Shared code is a directory, not a package.** `payload/addons/mail/src/shared/` holds
  identity, policy, profile, secrets, audit and rate limiting. Each add-on compiles its own copy;
  there is no cross-add-on runtime dependency to version.
- **Labels mode reads labels *and* folders.** `configuredScope(profile)` is the union of
  `labels` and `folders`, so the default `folders: ["INBOX"]` is a usable scope instead of an
  unreachable one. A name outside that union is `not_granted`.
- **The bot writes `secrets.env` directly.** It writes the file atomically with mode 600; the
  `/vault` store is a different feature and is not in this path. `secretStatus()` exposes
  presence only, never a value.
- **Enabling is one confirmation, not an agent picker.** The flow writes `"<id>_*": allow` into
  every agent that declares a `permission:` block, and the confirmation names them. A question
  with one right answer only invited a wrong one: skipping it left the tools installed but
  silently denied. There is still no per-agent `ask` switch; `setAgentPermission` accepts it, but
  the Telegram UI does not offer it.
- **`--check` validates manifests.** `install.sh --check` reports each bundled add-on as ok or
  warning without changing anything, using the same validator the installer runs.
- **`update.sh` restarts on a file change.** A version bump is not required: any difference in
  the bundled tree restarts `cilot-server`, because a running MCP process keeps its own copy of
  the code.
- **Uninstall keeps both config and state.** `uninstall.sh` removes the code and, with
  `--purge-addons` (implied by `--purge`), the config, credentials, state and the add-on MCP
  entries. The default keeps them so a reinstall does not silently drop a mailbox.
- **The add-on ships its own tests.** `payload/addons/mail/test/` uses the Node test runner
  against the built `dist/`, so no extra test dependency is installed at run time.

---

## 1. Goals and non-goals

### Goals

1. An add-on is a package that adds **tools the agent can call**. The tool is the product;
   configuration is how it is pointed at the right data.
2. Add-ons are **out of process**: one MCP server per add-on, started by OpenCode the same way
   the existing `telegram` MCP server is. An add-on crash or restart never touches the bot.
3. An operator can install, enable, configure, grant and revoke an add-on **from Telegram** with
   `/addons`. No manual JSON editing for the common path.
4. Per-user add-ons (mail, calendar, drive) can serve several Telegram accounts **without a
   shared credential** and without trusting the model to say who it is.
5. Add-on code, add-on config, add-on credentials and add-on state are four separate things with
   four separate lifetimes. `update.sh` replaces code and nothing else.
6. Adding an add-on to a running install does not require editing the bot's source.

### Non-goals (v1)

- **No sandbox.** Add-on code runs as the same Linux user as the bot. Installing an add-on is a
  statement of trust in its code, exactly like installing any npm package. The manifest's
  `capabilities` block documents intent; it does not enforce anything.
- **No per-user process isolation at the OS level.** Isolation is application-level: the process
  for one account's workspace holds only that account's credentials. A Telegram user is not a
  Linux user, and this document does not pretend otherwise.
- **No add-on marketplace or remote install by URL.** Phase 1 ships bundled add-ons only.
- **No background daemon.** "Notify me when mail arrives" is a scheduled `/task` in v1, not an
  IMAP IDLE worker. See §12.
- **No write tools for mail.** Read-only in v1: no send, reply, delete, label or mark-as-read.

---

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| **add-on** | A directory with a manifest and an MCP stdio server. Identified by `id`. |
| **bundled add-on** | Shipped in `payload/addons/<id>/`, installed by `install.sh`. |
| **external add-on** | Dropped into the data directory by the operator. Phase 2. |
| **scope** | `global` (one configuration for the machine) or `per-user` (a profile per Telegram id). |
| **grant** | What one Telegram account may do with one add-on: `off`, `use`. |
| **profile** | One account's config + credentials for one add-on. |
| **policy** | `policy.json`: the grant table. The only source of truth for authorization. |
| **account** | The Telegram id the current MCP process is serving, derived from its cwd (§5). |

---

## 3. Process model

Each add-on is registered as a **local MCP server** in the Cilot OpenCode config, exactly like
the bot's own `telegram` server today:

```jsonc
// ~/.config/cilot/opencode/opencode.jsonc
"mcp": {
  "servers": {
    "mail": {
      "type": "local",
      "command": [
        "/usr/bin/node",
        "/home/info/.local/share/cilot/addons/mail/dist/server.js"
      ],
      "environment": {
        "CILOT_ADDON_ID": "mail",
        "CILOT_ADDON_CONFIG_ROOT": "/home/info/.config/cilot/addons/mail",
        "CILOT_ADDON_STATE_ROOT": "/home/info/.local/state/cilot/addons/mail",
        "CILOT_USER_ROOT": "/home/info/.local/share/tg-workspaces/users"
      },
      "codemode": false
    }
  }
}
```

Rules:

- `codemode: false`, matching the `telegram` server. Code-mode would let the model compose calls
  in a runtime; add-on tools touch private data and are not offered that way.
- The `environment` block carries **paths only, never credentials**. Credentials are resolved by
  the add-on per account (§8).
- Registration is **global** (machine-wide), because OpenCode has one MCP namespace per server.
  Per-user behaviour is enforced inside the add-on, not by spawning it per user. See §7 for why
  this is still safe and §16 for what it does not hide.
- Enabling an add-on means adding this block and restarting `cilot-server.service`. Disabling
  means removing the block and restarting. No other file changes.
- Tool names are namespaced by the server name OpenCode assigns: a tool called `search` in the
  server `mail` appears to the model as `mail_search`. Add-on tool names are therefore short and
  unprefixed (§6).
- The add-on must not write to stdout except MCP protocol frames. Logs go to stderr, which
  OpenCode captures in its own log.

Why out of process rather than a module inside the bot:

| Concern | Out of process | In the bot process |
| --- | --- | --- |
| Crash | kills one server | kills the Telegram bot |
| Credential exposure | only its own env/files | sees bot env, possibly the bot token |
| Language | any | TypeScript in the bot's build |
| Enable/disable | config edit + restart | code change + rebuild |
| Reuse by the operator's own OpenCode | possible | no |

---

## 4. Directory and file layout

### 4.1 Code

```text
# In the repository (bundled add-ons)
payload/addons/<id>/
  addon.json               manifest (§6)
  default-config.json      seed copied to a new profile, never overwritten afterwards
  package.json
  src/
    server.ts              entry: protocol loop
    tools.ts               the tools, their schemas and the audit wrapper
    shared/                identity, policy, profile, secrets, audit, rate limit
    mail/                  IMAP, scope, attachments, cursor
  test/                    Node test runner cases against dist/
  dist/server.js           built output, committed and installed
  README.md

# On the machine
~/.local/share/cilot/addons/<id>/        code, owned by the installer
```

`update.sh` replaces `~/.local/share/cilot/addons/<id>/` wholesale. Anything an operator wants to
keep must live outside it.

### 4.2 Config, credentials, state

```text
~/.config/cilot/addons/<id>/                 mode 700
  policy.json                                grant table, mode 600        (§7)
  config.json                                profile for `scope: global`. mode 600
  secrets.env                                credentials for `scope: global`. mode 600
  users/<telegram id>/config.json            profile for `scope: per-user`. mode 600
  users/<telegram id>/secrets.env            credentials. mode 600
  users/<telegram id>/config.json.bak        last good profile, written on save

~/.local/state/cilot/addons/<id>/            mode 700
  users/<telegram id>/cursor.json            last-seen markers, dedupe keys
  users/<telegram id>/cache/                 optional, disposable
  audit.log                                  one JSON line per tool call, mode 600  (§14)
```

Rules:

- **Config and state never live under the code directory.** `update.sh` and `install.sh` must be
  able to replace code without reading or writing either.
- **One directory per account.** `users/<id>/` is the unit the admin manages: that account's
  config and credentials together. It is created when the admin grants the account and deleted
  when the admin revokes it.
- **Secrets never live in `*.json`.** They go in a mode-600 env file, one `KEY=value` per line,
  written atomically by the bot (not through the `/vault` store). JSON is what `/addons` prints
  in summaries and what a support request pastes into a chat; a secret must not be able to leak
  that way.
- Files are created with the mode above, not `chmod`ed afterwards.
- The add-on resolves roots from `CILOT_ADDON_CONFIG_ROOT` / `CILOT_ADDON_STATE_ROOT` and falls
  back to the XDG defaults when run by hand for a test.

---

## 5. Identity: who is calling

The add-on must not accept a user id as a tool argument. The model chooses arguments, and a model
that can be talked into `{"user": "1084045244"}` is not an access control.

Instead the add-on derives the account from **its own working directory**:

```text
process.cwd()
  /home/info/.local/share/tg-workspaces/users/1084045244/projects
  ─────────────────────────────────────────────  ────────
  CILOT_USER_ROOT                                 id
```

Resolution algorithm:

1. `realpath(process.cwd())`.
2. `realpath(CILOT_USER_ROOT)`. If either fails → `unknown_account`.
3. If cwd is not strictly under `<CILOT_USER_ROOT>/<digits>` → `unknown_account`.
4. The first path segment (digits) is the Telegram id.
5. If cwd is under `<parent of CILOT_USER_ROOT>/shared/` → `unknown_account` for every
   `per-user` add-on. A shared folder is reachable by several accounts, so the cwd names no
   single owner. Two users' agents run in the same directory and the process cannot tell them
   apart.
6. A `global` add-on skips steps 3–5: it has one profile and does not care who called.

Why cwd is trustworthy: OpenCode starts a **separate MCP server process per session/workspace**,
and the bot's own image tool already depends on that property ("each workspace gets its own MCP
process"). The cwd is set by OpenCode, not by the model, and the model cannot change another
process's cwd.

### 5.1 Spike S0 — verify before implementing

The per-workspace claim is currently supported by one comment and one log line. **Phase 1 must
start with this test.** If it fails, the entire identity model changes to a bot-side proxy and
the estimate roughly doubles.

Procedure:

1. Open a session for account A (`users/A/projects`) and one for account B (`users/B/projects`).
2. While both are alive, list the MCP processes and their cwds:

   ```bash
   for pid in $(pgrep -f 'addons/mail/dist/server.js'); do
     printf '%s -> %s\n' "$pid" "$(readlink /proc/$pid/cwd)"
   done
   ```

3. **Pass:** two processes, two different cwds under `users/A` and `users/B`.
   **Fail:** one process, or a cwd that is not a workspace.

#### Result — PASS, 2026-11-12

Verified against the live `cilot-server.service` (OpenCode 2.2.5, port 4156). The MCP server is
spawned **per directory, lazily**, when the client asks for that directory's tool catalog
(`GET /api/mcp?location[directory]=…`). Three directories produced three processes:

```text
pid 185719  ppid 87740 (cilot-server)  cwd …/users/630868685/projects
pid 185734  ppid 87740 (cilot-server)  cwd …/users/1084045244/projects
pid 185812  ppid 87740 (cilot-server)  cwd …/shared/s0probe          (probe, since removed)
```

Conclusions:

- `cwd → account` is sound. The model cannot influence another process's cwd.
- A shared folder gets its **own** process whose cwd is the shared path. The path prefix is enough
  to deny `per-user` add-ons there, so the shared-folder rule in §5 step 5 works without extra
  signalling.
- MCP processes can outlive the session that caused them (the probe's process was still alive
  after its session and directory were deleted). This reinforces §7.3: revoking a grant must
  restart the server, not merely delete a session.
- The working directory is inherited from the directory OpenCode serves, not from the server's
  unit `WorkingDirectory` (`/home/info`). A process with cwd `/home/info` belongs to the
  operator's own stack, not to a user workspace, and correctly resolves to `unknown_account`.

Until S0 passes, `per-user` remains a design, not a promise. It has passed.

### 5.2 Known consequences

- An admin session opened **outside** `users/<id>` (for example the project `/home/info` after
  `/access on`) resolves to `unknown_account`. The admin must select their personal workspace in
  `/projects` to use a per-user add-on. This is deliberate: "the directory does not name an
  account" must deny, not fall back to "probably the admin".
- A workspace moved or renamed after a session started changes nothing for that process; a new
  session resolves the new path.
- Symlinks are resolved, so a symlinked workspace still maps to the real account directory.

---

## 6. Manifest: `addon.json`

The manifest is the contract between the bot UI, the installer and the server. The bot renders
configuration forms **from the schema**, so adding an add-on does not require bot code changes.

```json
{
  "id": "mail",
  "name": "Mail",
  "version": "1.0.0",
  "description": "Read a mailbox, or only the labels you choose.",
  "entry": "dist/server.js",
  "scope": "per-user",
  "tools": [
    { "name": "search", "summary": "Search messages", "readOnly": true },
    { "name": "read", "summary": "Read one message", "readOnly": true },
    { "name": "labels", "summary": "List labels and folders", "readOnly": true }
  ],
  "secrets": [
    {
      "key": "MAIL_IMAP_PASSWORD",
      "label": "IMAP password or app password",
      "required": true,
      "secret": true
    }
  ],
  "config": {
    "mode": {
      "type": "enum",
      "values": ["labels", "mailbox"],
      "default": "labels",
      "label": "What the agent may read"
    },
    "labels": {
      "type": "string[]",
      "default": [],
      "label": "Labels (mode: labels)"
    },
    "folders": {
      "type": "string[]",
      "default": ["INBOX"],
      "label": "Folders"
    },
    "maxResults": {
      "type": "number",
      "default": 20,
      "min": 1,
      "max": 100,
      "label": "Results per search"
    },
    "sinceDays": {
      "type": "number",
      "default": 30,
      "min": 1,
      "max": 365,
      "label": "How far back to search"
    },
    "body": {
      "type": "enum",
      "values": ["none", "text"],
      "default": "text",
      "label": "Return body text"
    },
    "attachments": {
      "type": "enum",
      "values": ["none", "list", "download"],
      "default": "list",
      "label": "Attachments"
    },
    "attachmentMaxMB": {
      "type": "number",
      "default": 10,
      "min": 1,
      "max": 50,
      "label": "Largest attachment to download"
    }
  },
  "capabilities": {
    "network": ["imap.gmail.com:993"],
    "fs": []
  },
  "minCilotVersion": "1.1.0"
}
```

Field rules:

| Field | Required | Rule |
| --- | --- | --- |
| `id` | yes | `^[a-z][a-z0-9_]{1,23}$`, unique. Becomes the MCP server name and the tool prefix. |
| `name` | yes | Shown in `/addons`. |
| `version` | yes | Semver. Compared for update notices only. |
| `scope` | yes | `global` or `per-user`. |
| `entry` | yes | Relative path inside the add-on directory. Must not escape it. |
| `tools` | yes | The names the server exports. Used to generate `"<id>_*"` agent permissions and to sanity-check `tools/list`. |
| `secrets` | no | Keys are rendered into the per-profile env file. `secret: false` allows a non-sensitive value such as a login name. |
| `config` | no | Flat map of typed fields. Supported types: `string`, `number`, `boolean`, `enum`, `string[]`. No nested objects in v1. |
| `capabilities` | no | Documentation only. Not enforced. |
| `minCilotVersion` | no | The bot refuses to enable the add-on below this version. |

Schema validation happens in three places, all using the manifest:

1. `install.sh` — the entry file exists and the manifest parses.
2. The bot — it renders a form only for fields it understands, and refuses values that violate
   `min`/`max`/`enum`.
3. The add-on — it validates the saved profile on load and returns `invalid_config` rather than
   guessing a default that widens access.

Unknown fields are preserved on save, so a newer manifest can add a field without an older bot
wiping it.

---

## 7. Permissions: visibility, authorization, credentials

These are three different questions and they are answered in three different places.

| Question | Answered by | Scope |
| --- | --- | --- |
| Can the model see the tool? | `opencode.jsonc` + agent `permission` | machine / agent |
| May this call return this account's data? | add-on, reading `policy.json` | Telegram id |
| Whose mailbox is it? | the env file chosen for the account | Telegram id |

### 7.1 Grants

`policy.json` is the single source of truth. The bot writes it; the add-on reads it on **every
tool call**. Nothing else records a grant, so there is no second copy to drift.

```json
{
  "version": 1,
  "default": "admin-only",
  "users": {
    "1084045244": { "grant": "use", "updatedAt": "2026-11-12T10:00:00.000Z" },
    "555000111": { "grant": "use" }
  }
}
```

| Grant | `/addons` shows | Agent may call | Account may change config | Account may set secrets |
| --- | --- | --- | --- | --- |
| `off` (default) | nothing | no: `not_granted` | no | no |
| `use` | read-only summary | yes, with the profile the admin set | no | no |
| admin (own profile, `use` + bot admin) | full editor + grant UI | yes | yes, through the admin UI | yes, through the admin UI |

Notes:

- **There is no admin grant value and no self-service grant.** The admin is an ordinary account
  with `use`, plus `admin_commands` in the bot, which is what lets them edit every row and every
  profile. An account with `use` cannot edit its own profile or enter its own password; this is
  the whole point of the model (§7.2). The add-on itself has no concept of an admin, so it has no
  privilege logic to get wrong.
- **`default: "admin-only"`** means an id with no row is `off`. A new account never inherits a
  new add-on by accident.
- `default: "all-users"` is allowed but only meaningful for `scope: global`; the bot refuses to
  set it on a `per-user` add-on without an explicit confirmation, because every allowed account
  would get a slot with no credential and calls would fail with `missing_secret`.
- A freshly installed add-on is **disabled** (no MCP entry) until the admin finishes its global
  configuration and enables it.

### 7.2 The admin configures, the account only uses

A `use` account has no editor. It sees the summary, the state of its credentials (`set` or
`not set`) and a Test button. Everything else — mode, labels, limits, credentials — is entered by
the admin from `/addons → Accounts`.

State the consequences plainly, because they are real:

- The admin types each account's mail password. The admin can therefore read that mailbox with or
  without Cilot. The add-on does not create that power; it makes it visible in one place and
  auditable.
- The add-on has no cross-user tool: a call is served with the profile for the cwd the process
  runs in. But an admin who opens another account's workspace as a project (which `/access on`
  already allows) runs in that account's cwd and is served that account's profile. The boundary is
  the bot's `cross_user_projects` capability, not the add-on. `CILOT_CONFINE_ADMINS=true` removes
  it.
- A profile is never shared between ids. Two accounts configured with the same mailbox are two
  profiles with two credentials; the add-on does not deduplicate them.

### 7.3 Revocation

`off` takes effect on the next call, because the policy is read each time. Two extra steps make
revocation complete:

1. On `off`, the bot deletes `users/<id>/` (config and credentials together) by default, and asks
   before keeping it.
2. The bot restarts `cilot-server.service`, which kills every MCP process and clears any secret
   that is still in memory. A running process is not left holding a credential for an account
   that just lost access.

### 7.4 What this does not hide

MCP registration is global. If an add-on is enabled at all, its tools appear to every session that
the agent permission allows. A standard account will see `mail_search` in the tool list even when
its grant is `off`, and a call returns `not_granted`.

This is acceptable because visibility grants no data. Hiding the tool per user would require a
per-user `opencode.jsonc`, which the user can edit anyway; it is a UX change, not a security
boundary. The security boundary is the profile and the policy check.

The agent permission side still matters: the standard agents (`social-media`, `postiz-social`)
declare `"*": deny`, so an add-on tool is **not callable** by a standard account until the
operator adds `"<id>_*": allow` to that agent. Enabling an add-on in `/addons` does exactly that
for every agent that declares a `permission:` block, and leaves agents without one untouched.
See §9.

---

## 8. Credentials

- One env file per profile: `secrets.env` for `global`, `users/<id>/secrets.env` for `per-user`.
- Only the admin enters credentials. A `use` account never sees a value and never gets a form; it
  sees `set` or `not set`.
- Mode `600`, owned by the bot's Linux user, written atomically (temp file + rename).
- The bot renders it from the same secret store that backs `/vault`, so masking, deletion and
  "apply and restart" behave the same way. The bot never prints a value back; `/addons` shows
  `MAIL_IMAP_PASSWORD: set` or `not set`.
- The add-on loads the file itself after resolving the account. It does **not** receive secrets in
  its process environment, because OpenCode's `environment` block is static and shared by every
  workspace — putting a credential there would hand every account the same one.
- The add-on must not log values, must not include them in error messages, and must not pass them
  to a subprocess.
- Changing a secret requires restarting the server (the process reads the file once at start).
  Changing config does not: config is re-read per call. `/addons` says which is which.

Env file format:

```dotenv
# ~/.config/cilot/addons/mail/users/1084045244/secrets.env — mode 600
MAIL_IMAP_HOST=imap.gmail.com
MAIL_IMAP_PORT=993
MAIL_IMAP_USER=person@example.com
MAIL_IMAP_PASSWORD=...
```

Values are used literally after the first `=`; no shell expansion, no quoting rules. The parser
rejects a line without `=` and rejects keys outside `^[A-Z][A-Z0-9_]*$`.

---

## 9. Tool registration and naming

- The MCP server exports tools with **short names**: `search`, `read`, `labels`.
- OpenCode prefixes them with the server name from `opencode.jsonc`: `mail_search`,
  `mail_read`, `mail_labels`.
- The prefix is part of the integration contract. `/task` prompts, the docs and the agent
  permission blocks use the prefixed name.
- The add-on's `tools/list` must match the manifest's `tools[].name`; a mismatch is a warning in
  the audit log and a failed self-test, not a crash.
- Collisions with `telegram_*` and `postiz_*` are impossible by construction, because the server
  name is the add-on `id` and ids cannot be `telegram` or `postiz`.
- Every tool declares `readOnly: true|false`. All v1 mail IMAP tools are read-only. A future tool
  that changes the mailbox must be `readOnly: false` and is refused unless the admin set
  `allowWrite: true` in that account's profile. `mail_ack` is not in this category: it writes the
  local cursor only, never the mailbox.
- Enabling writes `"<id>_*": allow` into the `permission` block of every agent that declares one,
  in `~/.config/cilot/opencode/agents/<agent>.md`, and the confirmation screen lists them. The UI
  does not offer a per-agent or per-call confirmation mode.

---

## 10. `/addons` — the Telegram UI

One command, two views, chosen by `policyForUser`.

### 10.1 List

```
/addons

Add-ons
✅ Mail        per-user · labels: Cilot, Important
⛔ Weather     global · disabled

Tap an add-on to configure it.
```

- A standard account sees only add-ons whose grant is not `off`.
- An admin sees every installed add-on, including disabled ones, and a marker when a grant is
  pending (`2 accounts without access`).
- The list is built from installed manifests, not from enabled MCP entries: an add-on can be
  installed but off.

### 10.2 Admin detail

```
Mail — enabled
per-user · 2 of 4 accounts

My profile      labels: Cilot, Important
Accounts        ✅ 630868685  (use)
                ✅ 1084045244  (use)
                ⛔ 555000111  (off)
Default policy  admin-only
[ My profile ] [ Accounts ] [ Secrets ] [ Test ] [ Disable ]
```

- **My profile** opens the schema-driven form (§10.4) for the admin's own id.
- **Accounts** lists every configured Telegram id with its grant; tapping cycles `off → use →
  off`. Opening an account shows its config form and secret editor, both filled in by the admin.
- **Default policy** switches `admin-only` / `all-users` (the latter only for `global`).
- **Secrets** opens the secret editor for the admin's own profile or for the selected account a
  `use` row points at.
- **Test** runs `node <entry> --selftest` with the selected profile and reports login, message
  count and the resolved account. It never prints message content.
- **Disable** removes the MCP entry, restarts the server, and leaves config and policy in place.

### 10.3 Standard-user detail

```
Mail
labels: Cilot, Important · max 20
Credentials: set

[ Test ] [ How to ask for a change ]
```

A `use` account sees only this summary. There are no edit buttons: the admin owns the profile and
the credentials. If a field is wrong, the account asks the admin. The second button sends the
admin a short message naming the account and the add-on; it does not open a form.

### 10.4 Config form

Only the admin sees these forms; they are reached from **My profile** or from an account in
**Accounts**. The bot renders one screen per field or per small group, from `addon.json`:

- `enum` → inline keyboard of values.
- `boolean` → two buttons.
- `number` → a text prompt with `min`/`max`, re-prompting on invalid input.
- `string[]` → a comma-separated text prompt, normalised (trim, dedupe, drop empties). An empty
  list is allowed only when the field is not required, and the summary says `none`.
- `string` → a text prompt.

Saving writes the whole profile atomically and re-reads it to validate. Switching `mode` from
`mailbox` to `labels` with no labels is refused: that would silently read nothing, and the
operator would think the add-on was broken.

### 10.5 Enabling

```
[ Enable ] → confirm: "The agent will be able to read <scope> for accounts with a grant."
                      "Agents that will be allowed: social-media, postiz-social"
           → add MCP entry, add "<id>_*" permission to every gated agent, restart cilot-server
```

The confirmation names the scope, the account count and the agents, so enabling a `per-user`
add-on is never a one-tap accident. It is still one tap: the agent list is reported, not asked.

---

## 11. Error contract

A tool failure is an MCP result with `isError: true`, not a transport error. The existing protocol
already does this: `tool.run` throwing produces `{ content: [{type:"text", text}], isError: true }`.
The add-on's error text starts with a stable machine-readable code so the model and the tests can
branch on it without parsing prose.

```text
not_granted: this account has no access to the mail add-on.
```

| Code | When | Agent should |
| --- | --- | --- |
| `not_granted` | policy says `off`, or no policy row | tell the user an admin must grant access; do not retry |
| `unknown_account` | cwd is not under `users/<id>` (shared folder, root, operator dir) | ask the user to switch to their personal workspace |
| `not_configured` | profile missing, or a required field is unset | ask an admin to finish setup |
| `not_editable` | a `use` account tries to save config (UI path only) | explain that the admin manages it |
| `invalid_config` | profile fails schema validation | report the field; do not guess |
| `missing_secret` | a required secret is absent | ask the user/admin to add it, never echo the key's value |
| `too_large` | an attachment exceeds `attachmentMaxMB` | report the name and limit; do not retry |
| `upstream_error` | IMAP/DNS/auth failure | report a short cause; do not retry in a loop |
| `rate_limited` | the add-on's own per-account budget is exhausted | stop and report |

Rules:

- The message never contains a credential, a full message body, or a stack trace. Stack traces go
  to stderr.
- `unknown_account` and `not_granted` are deliberately distinct: one is "wrong directory", the
  other is "no permission", and conflating them sends the user to the wrong fix.
- A denied call is written to the audit log with the code, but not with the arguments that might
  contain message text.

---

## 12. Notifications

v1 has no daemon. A "tell me about new mail" feature is a scheduled task that calls the tool:

```
/task every 15 minutes: search label Cilot since the last check, and post one line per new message with sender and subject
```

The add-on supports this with state, not with a background process:

- `state/users/<id>/cursor.json` holds `{ "lastSeen": "<ISO>", "seenIds": ["<Message-ID>", ...] }`.
- `mail_search` accepts `since` and `excludeSeen`, and returns `uid`/`messageId` for each hit.
- `mail_mark_seen` is **not** a tool. Marking is a side effect of a successful *notification*
  delivery, performed by the scheduled task through a small `mail_ack` write tool that only
  updates the cursor file. It never writes to the mailbox, so "read-only" stays true for IMAP.
- The cursor is per account and per add-on, so two accounts never acknowledge each other's mail.

Phase 3, only if needed: an add-on → bot notification channel over a Unix socket in
`~/.local/run/cilot/`, with a per-add-on token, so an add-on can push an event without holding
the bot token. That is a separate design and is not part of 1.1.0.

---

## 13. The mail add-on (reference implementation)

### 13.1 Scope

Read-only IMAP. Two modes:

| Mode | What `mail_search` may look at | Typical use |
| --- | --- | --- |
| `labels` (default) | only the configured labels/folders | "watch the Cilot label" |
| `mailbox` | all folders in the account | "find that invoice" |

Switching to `mailbox` requires an explicit confirmation that names the account and says the
agent can read the whole mailbox. The choice is stored per profile, so one account can be narrow
while another is broad.

### 13.2 Tools

| Tool (full name) | Arguments | Returns |
| --- | --- | --- |
| `mail_labels` | none | folder/label names with unread counts. Used to discover valid labels. |
| `mail_search` | `query?`, `label?`, `folder?`, `since?`, `limit?`, `excludeSeen?` | up to `limit` (capped by config `maxResults`) summaries: `uid`, `messageId`, `from`, `subject`, `date`, `snippet`, `labels` |
| `mail_read` | `uid`, `folder?`, `attachments?` | one message: headers, text body (truncated to 20 KB), attachment names and sizes; with `attachments: "download"`, the files are written to the workspace and returned as resource links |
| `mail_ack` | `messageIds[]` | advances the cursor. Write tool, cursor only, never IMAP. |

Argument rules:

- `label` and `folder` are validated against `mail_labels` output. An unknown name is
  `invalid_config`, not an empty result, so the model cannot silently search the wrong place.
- In `labels` mode, a `label`/`folder` outside the configured set is refused even if it exists.
  In `mailbox` mode, any folder is allowed.
- `limit` is clamped to `maxResults`; asking for more is not an error, it just returns the cap
  and says so in the text.
- `query` is passed to IMAP `SEARCH`; the add-on never builds a raw command string.
- `mail_read` on a `uid` outside the configured scope returns `not_granted`, not "not found".
- `attachments` is `none`, `list` or `download`, defaulting to the profile's `attachments` field.
  It can only narrow that field, never widen it: a `use` account cannot ask for `download` when
  the admin set `list`. An attachment above `attachmentMaxMB` is listed as `too_large` and is not
  written.

### 13.3 Defaults

```json
{
  "mode": "labels",
  "labels": [],
  "folders": ["INBOX"],
  "maxResults": 20,
  "sinceDays": 30,
  "body": "text",
  "attachments": "list",
  "attachmentMaxMB": 10
}
```

`mode: labels` with an empty `labels` list is valid at install time but blocks `mail_search` with
`not_configured`. This is the safe default: nothing is readable until the operator names what is
readable.

### 13.4 Read-only IMAP, writable workspace

The mailbox is never modified. The workspace is, because an attachment has to land somewhere for
the agent to send it.

Mailbox rules:

- No `SEND`, `APPEND`, `STORE`, `COPY`, `MOVE`, `EXPUNGE` in the IMAP client's allowed command
  set. The connection is opened with the read-only mailbox flag where the server supports it.
- `markAsRead` is not a config field. A message read through the tool stays unread unless the
  user reads it in their own client. This surprises some operators, so `/addons` says it on the
  Mail screen.

Attachment rules:

- `attachments: "download"` writes each part to
  `<workspace>/mail-attachments/<messageId>/<safe-name>` and returns a `resource_link` plus the
  absolute path. Image parts are also returned as MCP `image` content, which is how the existing
  `image_generate` tool hands a picture to Telegram.
- `safe-name` is the basename only: directory separators, `..`, control characters and leading
  dots are removed. A name collision gets `-1`, `-2`, never an overwrite.
- The target is resolved with `realpath` and must stay inside `process.cwd()`. A symlink planted
  in the workspace cannot redirect the write.
- Directories are mode `700`, files mode `600`. A part larger than `attachmentMaxMB`, or a call
  whose parts total more than 25 MB, is reported as `too_large` and skipped. The rest of the
  message is still returned.
- Nothing is executed. An `.exe` or `.sh` attachment is a file the agent may read or forward, not
  something the add-on runs.
- Files are not cleaned up automatically. They are in the account's workspace, where the user can
  delete them; `mail_attachments_clean` is deliberately not a tool in v1.

### 13.5 IMAP details

- **Authentication: IMAP `AUTH=PLAIN` over TLS, using an app password.** This is the decision for
  1.1.0. It needs no OAuth application registration, works with Gmail, Outlook/Microsoft 365
  (app password where the tenant allows it), Fastmail and generic IMAP, and a user can revoke one
  app password without touching their account password. The bot tells the admin to create one and
  never asks for the primary password. XOAUTH2 is deferred (§19); the env schema has room for
  `MAIL_IMAP_ACCESS_TOKEN` later without changing the file layout.
- IMAP over TLS on 993 by default; `starttls` on 143 is allowed by config. A server that offers
  neither is refused with `not_configured`.
- Host, port, user and password come from the profile's env file. The account is the cwd's id, so
  a profile cannot be pointed at another account's mailbox by a tool argument.
- One connection per tool call, closed in `finally`. No pooled connection that could outlive a
  revoked grant. This is slower, and deliberately so.
- A login failure is `upstream_error` with the server's response code, never the password.
- Per-account rate limit: 30 calls/minute, enforced in-process. A scheduled task every 15 minutes
  is nowhere near it.

### 13.6 Example interaction

> **User:** có mail mới trong label Cilot không?
>
> **Agent:** *(calls `mail_search` with `{ "label": "Cilot", "since": "2026-11-05", "limit": 10 }`)*
> Có 2 mail mới: …

The agent does not name an account; the account is the process's workspace. The add-on does not
ask which mailbox; the profile decides.

---

## 14. Audit

`~/.local/state/cilot/addons/<id>/audit.log`, one JSON object per line, mode 600:

```json
{"ts":"2026-11-12T10:21:03.114Z","account":"1084045244","tool":"mail_search","ok":true,"code":null,"results":3,"bytes":812}
{"ts":"2026-11-12T10:21:04.002Z","account":"555000111","tool":"mail_search","ok":false,"code":"not_granted","results":0,"bytes":0}
```

- Never logs subjects, senders, bodies, query text or credentials.
- Rotated by size (1 MB × 3) inside the add-on, not by logrotate.
- `/addons → Audit` (admin) shows the last 50 entries for one account: tool, time, ok/code.
- Deleting the file is allowed; it is not a security control, it is an explanation of what
  happened.

---

## 15. Installer, update and uninstall

### 15.1 `install.sh`

New step, right after `copy_payload`:

1. **Copy** `payload/addons/*` to `$INSTALL_ROOT/addons/<id>/`, excluding `node_modules`.
2. **Install** each bundled add-on with `npm ci --omit=dev`, and keep the committed `dist/`.
   Only when `dist/server.js` is absent does it run the full build, which needs the dev
   toolchain. A failure is fatal for that add-on only, with a clear log path; the bot install
   still succeeds.
3. **Validate** each manifest: id pattern, entry exists, `minCilotVersion` ≤ current.
4. **Seed config** only when `~/.config/cilot/addons/<id>/` does not exist. A re-run never
   touches an existing profile or policy.
5. **Register** nothing. A new add-on starts disabled; the admin enables it in `/addons`.
   (Power users can pass `--enable-addon mail` to register it during install.)
6. **Create** `~/.local/share/cilot/addons` and `~/.config/cilot/addons` with mode 700.
7. **Write** `CILOT_ADDON_ROOT=$INSTALL_ROOT/addons` into `server.env` so the bot can find
   manifests without hard-coding the path.

`--check` reports each bundled add-on as `[ok]`, `[skip]` (missing) or `[warn]` (manifest
invalid), and never changes anything.

### 15.2 `update.sh`

- Replaces `$INSTALL_ROOT/addons/<id>/` for bundled add-ons, running `npm ci --omit=dev` and
  keeping the committed `dist/` when the tree did not change.
- Never reads or writes `~/.config/cilot/addons/` or `~/.local/state/cilot/addons/`.
- After replacing code, restarts `cilot-server.service` if any bundled add-on's files changed.
  A version bump is not the signal: the tracked source can change without one, and a running MCP
  process keeps the code it started with.
- An add-on removed from `payload/addons` is left on disk. The operator removes it, which keeps
  an update from deleting code the machine may still be serving.

### 15.3 `uninstall.sh`

- Removes `$INSTALL_ROOT/addons/` with the install root.
- **Keeps** `~/.config/cilot/addons/` and `~/.local/state/cilot/addons/` by default, because they
  contain credentials and cursors that a reinstall should not silently drop.
- `--purge-addons` names both directories before asking for confirmation, then removes them and
  the MCP entries whose `environment.CILOT_ADDON_ID` marks them as add-ons. `--purge` implies it.
  A config file that does not parse as plain JSON is left alone rather than rewritten.

### 15.4 Bot-side services

The bot gets a small set of modules, not a plugin framework:

| Module | Responsibility |
| --- | --- |
| `addon-manifest-service.ts` | discover and validate manifests under `CILOT_ADDON_ROOT` |
| `addon-policy-service.ts` | read/write `policy.json`, atomic, per add-on |
| `addon-config-service.ts` | read/write profiles, schema validation, defaults |
| `addon-secret-service.ts` | render `users/<id>/secrets.env` through the existing vault store |
| `addon-registry-service.ts` | add/remove the MCP entry in `opencode.jsonc`, restart the server |
| `addon-audit-service.ts` | tail `audit.log` for the admin view |
| `addon-callback-handler.ts` | the `/addons` menu, forms and confirmations |
| `addons-command.ts` | the command entry point and access check |

There is no dynamic import of add-on code in the bot. The bot reads manifests and files; it never
executes add-on JavaScript. The one place it spawns add-on code is `/addons` → Test, which runs
`node <entry> --selftest` in the target account's workspace and reads one JSON line from it.

---

## 16. Security notes and threat model

### 16.1 What is enforced

- A tool call is authorized by `policy.json` + the process cwd, neither of which the model
  controls.
- A per-user profile holds one account's credentials; another account's process cannot read it
  unless the Linux user can read the file, and then it is a file-permission failure, not an
  add-on one.
- Config and secrets are separate; a config value can be printed in a chat without leaking a
  password.
- Enabled add-ons are denied to the standard agents until the operator grants the namespace.
- Revocation is immediate for authorization and restart-deep for credentials.

### 16.2 What is not enforced

- Add-on code is trusted. `capabilities` is documentation. A malicious add-on can read
  `~/.config/cilot/secrets.json` and the bot's `.env`, including the Telegram token, because it
  runs as the same Linux user.
- A Telegram user is not a Linux user. Any process on the machine can read every profile that
  the Linux user can read. This is the same boundary as the rest of Cilot.
- The admin enters every credential, so the admin can read every configured mailbox outside
  Cilot. The add-on does not widen that, but it does not hide it either; §7.2 says so on the
  admin screen.
- Tool visibility is machine-wide (§7.4).
- In-memory data survives until the process exits; revocation restarts the server to bound that
  window.

### 16.3 Prompt-injection considerations

- Message bodies are untrusted input. The mail add-on wraps returned text in a marker and the
  tool description tells the model that message content is data, not instructions. This reduces
  the risk; it does not eliminate it. The real protection is that the add-on exposes no write
  tool, so a successful injection cannot send, delete or exfiltrate through the mail server.
- `mail_search` results include only the configured scope, so an injected "search the whole
  mailbox" is refused in `labels` mode.
- Attachment content is untrusted in exactly the same way as a body. The add-on returns bytes and
  a path; it never interprets them and never runs them. An attachment can still carry text that
  the model reads, so the wrapper rule applies to attachments too.
- Downloaded attachments are the one place a message can write to the workspace. Names are
  sanitised, paths are confined to the workspace, nothing is executed, and no existing file is
  overwritten (§13.4).

### 16.4 Failure modes

| Failure | Behaviour |
| --- | --- |
| Add-on crashes on start | OpenCode logs it; other tools still work; `/addons` shows `unhealthy` after a self-test |
| Malformed `policy.json` | fail closed: every account is `off`, the bot reports the parse error |
| Malformed profile | that account gets `invalid_config`; other accounts are unaffected |
| Manifest deleted while enabled | bot keeps the MCP entry but marks the add-on `orphaned`; `/addons` offers Disable |
| Disk full while writing config | atomic write leaves the old file; the save reports failure |

---

## 17. Internationalisation

Every string is added to all 13 locales, even if the first pass is English text, so a missing
translation is a lint error rather than a runtime `undefined`.

Keys (namespace `addons.`):

```text
addons.title, addons.empty, addons.disabled, addons.enabled, addons.unhealthy
addons.scope.global, addons.scope.per_user
addons.grant.off, addons.grant.use
addons.list.line            {name} {scope} {summary}
addons.detail.header        {name} {state} {scope}
addons.detail.accounts      {granted} {total}
addons.config.field         {label}
addons.config.saved
addons.config.invalid       {field} {reason}
addons.config.labels_empty
addons.config.mode_mailbox_confirm   {account}
addons.secret.set, addons.secret.unset, addons.secret.prompt {label}
addons.enable.confirm       {scope} {accounts}
addons.enable.agents        {agents}, addons.enable.agents_none
addons.disable.confirm
addons.test.running, addons.test.ok {messages}, addons.test.failed {code}
addons.attachments.none, addons.attachments.list, addons.attachments.download
addons.attachments.saved {count} {directory}
addons.error.too_large {name} {limit}, addons.error.not_editable
addons.audit.title, addons.audit.line {time} {account} {tool} {code}
addons.error.not_granted, addons.error.unknown_account, addons.error.not_configured
addons.error.invalid_config, addons.error.missing_secret, addons.error.upstream
cmd.description.addons
```

`cmd.description.addons` is registered for admins only; standard accounts still see `/addons` in
the command list only when they have at least one non-`off` grant, so the command does not
advertise an empty screen.

---

## 18. Test plan

### 18.1 Unit (add-on, no network)

- Identity: `users/123/projects` → `123`; `users/123` → `123`; `shared/x` → `unknown_account`;
  `/home/info` → `unknown_account`; a symlink into `users/123` resolves to `123`.
- Policy: missing row + `admin-only` → `off`; `use` returns data; `use` cannot save a profile
  through the UI service; malformed JSON → all `off`.
- Config: defaults from `default-config.json`; enum/number validation; unknown keys preserved;
  atomic save leaves the old file on a simulated failure.
- Secrets: parser rejects a bad key, a line without `=`, and does not expand `$VAR`.
- Errors: every code in §11 is produced by the documented condition and carries no secret.
- Mail: label scope refuses an unlisted label; `mailbox` allows it; `limit` clamps; `mail_read`
  refuses an out-of-scope uid; `attachments: "download"` cannot widen a `list` profile; no write
  IMAP command is constructed.
- Attachments: `../../etc/passwd` becomes `passwd`; a symlink target outside cwd is refused; a
  51 MB part is `too_large`; an existing name gets `-1` instead of being overwritten.

### 18.2 Integration (fake IMAP server)

- `mail_search` in `labels` mode returns only the seeded label.
- `mail_read` truncates a 1 MB body to 20 KB and reports the truncation.
- Cursor: `mail_ack` prevents the same message id from being returned by `excludeSeen` twice.
- Rate limit returns `rate_limited` on the 31st call in a minute.

### 18.3 Bot

- `/addons` for a standard account with `off` gives the empty state, not an error.
- `/addons` for admin lists disabled add-ons.
- Granting `use` then revoking `off` deletes `users/<id>/` and calls the restart once.
- Enabling writes the MCP entry and the permission line; disabling removes both.
- An operator-edited `policy.json` is re-read, not cached.
- i18n: every `addons.*` key exists in all 13 locales.

### 18.4 End-to-end (manual, two accounts)

1. Install, `/addons` shows Mail disabled.
2. Admin enables Mail for `social-media`, configures `labels: [Cilot]`, adds a credential.
3. Admin sets a different credential for account A; A's calls return A's results.
4. Account B (`off`) sees the empty state; a forced `mail_search` returns `not_granted`.
5. A session in a shared folder returns `unknown_account`.
6. Revoke A while its session is open: the next call fails and the server restarted.
7. `update.sh` replaces code and leaves A's profile intact.

### 18.5 S0

As in §5.1. This is a prerequisite, not a test of the implementation.

### 18.6 Shipped in 1.1.0

| File | Covers |
| --- | --- |
| `payload/addons/mail/test/identity.test.mjs` | cwd → account, shared folder, non-numeric segment, symlink |
| `payload/addons/mail/test/policy.test.mjs` | both defaults, explicit rows, malformed JSON fails closed |
| `payload/addons/mail/test/profile.test.mjs` | defaults merge, per-type validation, labels mode needs a scope |
| `payload/addons/mail/test/secrets.test.mjs` | literal parsing, missing file, missing key |
| `payload/addons/mail/test/scope.test.mjs` | labels union, out-of-scope refusal, mailbox mode |
| `payload/addons/mail/test/attachments.test.mjs` | traversal, symlink escape, overwrite, size limits |
| `payload/addons/mail/test/cursor.test.mjs` | dedupe, per-account isolation, 500-id bound |
| `payload/addons/mail/test/protocol.test.mjs` | initialize, tools/list, isError result, image content |
| `tests/app/services/addon-*.test.ts` (bot) | manifest discovery, policy, profile, credentials, registry |
| `tests/bot/callbacks/addon-callback-handler.test.ts` | the admin/standard split and the text stages |

The integration cases in §18.2 need a fake IMAP server and are not shipped; they are covered
manually by the `--selftest` path and the two-account walkthrough in §18.4.

---

## 19. Open questions

| # | Question | Default if unanswered |
| --- | --- | --- |
| 1 | S0 result: one MCP process per workspace? | **Passed 2026-11-12** (§5.1). No longer open. |
| 2 | Should the admin be able to keep a revoked profile's data? | Ask at revoke time; default delete. |
| 3 | Do we need per-agent grants (mail for `social-media` only)? | No in v1; permission is per add-on. |
| 4 | OAuth (Gmail) instead of app passwords? | App password in v1, decided in §13.5; XOAUTH2 is its own project. |
| 5 | Where do external add-ons come from? | Operator drops a directory; no URL install in 1.1.0. |
| 6 | How long are downloaded attachments kept? | Indefinitely, in the workspace; the user or admin deletes them. |

---

## 20. Phased roadmap

| Phase | Deliverable | Estimate |
| --- | --- | --- |
| **0** | S0 spike — done, see §5.1 | done |
| **1** | Manifest, discovery, policy, config, secrets, `/addons` list + forms, mail add-on read-only (`labels`/`mailbox`), installer/update/uninstall, docs | 4–5 days |
| **2** | Self-test, audit view, cursor + `/task` notification recipe, 13 locales, `--enable-addon` | 2 days |
| **3** | Notification socket, external add-ons, XOAUTH2 | 1 week |

Phase 1 is the smallest slice that answers the user's question: an add-on the agent can call, with
a config surface in `/addons`, and an admin controlling who may use it.

---

## 21. Implementation file map

### Repository

```text
ADDONS.md                                   this document
payload/addons/mail/addon.json
payload/addons/mail/default-config.json
payload/addons/mail/package.json
payload/addons/mail/package-lock.json
payload/addons/mail/src/server.ts           entry: stdio loop, --selftest
payload/addons/mail/src/protocol.ts         JSON-RPC framing
payload/addons/mail/src/tools.ts            tool schemas, audit wrapper
payload/addons/mail/src/shared/             identity, policy, profile, secrets, audit, rate limit
payload/addons/mail/src/mail/               imap, scope, attachments, cursor
payload/addons/mail/dist/                   committed build output
payload/addons/mail/test/                   Node test runner cases
payload/addons/mail/README.md
install.sh                                  copy/build/validate/seed; --enable-addon; --check
update.sh                                   replace code, restart on any bundled-file change
uninstall.sh                                remove code, keep config; --purge-addons
README.md                                   link to this document, "Add-ons" section
ARCHITECTURE.md                             add-on process model, security boundary, docs link
```

### Bot

```text
src/app/services/addon-manifest-service.ts
src/app/services/addon-policy-service.ts
src/app/services/addon-config-service.ts
src/app/services/addon-secret-service.ts
src/app/services/addon-registry-service.ts
src/app/services/addon-audit-service.ts
src/bot/commands/addons-command.ts
src/bot/callbacks/addon-callback-handler.ts
src/bot/menus/addon-menu.ts
src/bot/commands/definitions.ts             register `addons`
src/i18n/*.ts                               addons.* keys in 13 locales
tests/app/services/addon-*.test.ts
tests/bot/callbacks/addon-callback-handler.test.ts
```

### Live machine after install

```text
~/.local/share/cilot/addons/mail/           code
~/.config/cilot/addons/mail/policy.json
~/.config/cilot/addons/mail/users/<id>/config.json
~/.config/cilot/addons/mail/users/<id>/secrets.env
~/.local/state/cilot/addons/mail/users/<id>/cursor.json
~/.local/state/cilot/addons/mail/audit.log
```

---

## Appendix A — `policy.json` transitions

```text
install        → file does not exist; effective default = admin-only; nobody granted
enable         → admin row written: { "<admin id>": { "grant": "use" } }
grant use      → row added/updated; admin then fills users/<id>/config.json and secrets.env
revoke         → row removed (or "off"); users/<id>/ deleted after confirmation
disable        → policy kept; MCP entry removed; restart
uninstall      → policy kept unless --purge-addons
```

Writes are atomic and serialized by the bot's single process. If an operator edits the file by
hand, the add-on sees the change on the next call; the bot re-reads before rendering `/addons`,
so the UI and enforcement agree.

## Appendix B — Why not one MCP server for all add-ons?

A single server would have one process per workspace and one tool namespace. It would need a
dispatcher, a manifest registry and a plugin loader inside the server, and a crash in one add-on
would take the others down. It also makes the tool prefix ambiguous (`addon_search`).

One server per add-on costs one process per workspace per enabled add-on, which is acceptable:
OpenCode already starts one `telegram` server per workspace, and add-ons are few. The isolation is
worth the memory.
