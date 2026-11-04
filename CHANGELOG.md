## 0.28.0 — OpenCode 2.x, a local MCP server, and a vault for secrets

The Telegram bot now runs on the 2.x API. It used to need `1.18.32` because it called the
root-level endpoints and because 2.x had no `tool` key to load the three TypeScript tools from
`opencode/tools/`. Both are closed:

- `OPENCODE_API_FLAVOR=v2` switches the client to `/api/*` and adapts the responses and events
  back to the shapes the Telegram UI already understands. The live reply, tool and session
  paths were re-tested against `2.2.5`.
- `image_generate`, `postiz_check_post` and `postiz_upload_image` are served by the bot's own
  stdio MCP server and registered as `mcp.servers.telegram` with `"codemode": false`. Without
  that flag OpenCode only exposes the tools inside a `tools.telegram.*` sandbox and a direct
  call fails. The agent prompts and skills now use the `telegram_*` names OpenCode actually
  exposes; the adapter maps them back to the V1 names for the bot's own logic.
- Generated images come back as MCP `image` content and are forwarded to Telegram from the
  tool result, not by re-reading disk.
- `telegram_postiz_upload_image` reads files itself, outside OpenCode's `read` permission, so
  it stays inside `POSTIZ_UPLOAD_ALLOWED_ROOTS` **and** refuses a file in the shared
  generated-images directory that the same MCP process did not write. One MCP process runs per
  workspace, which is enough to stop one account publishing another account's image.

New `/vault` menu for the first configured admin: provider keys go through the server's
integration API, custom env secrets go to `secrets.json` (mode `600`) and are rendered to
`secrets.env` for the server unit. Values are masked, the message is deleted after entry, and
they are never sent to the model. The server restarts only when the button is pressed.

Also in this release:

- The live default model is `opencode/crouton-alpha-free`. `nvidia/nemotron-3.5-lightning:free`
  called the wrong tool and mixed `experimental_image_generate` into replies.
- The `postiz-social` agent had no `permission:` block at all while standard accounts could
  select it, which left a shell reachable. It is now deny-by-default like `social-media`.
- Installing a fresh copy drops stale `tools/*.ts` files left by 1.x.

## 0.27.1 — Never offer a model the provider has retired

The configured model on this machine, `opencode/space-bunny-free`, no longer exists in the
provider catalog. Nothing noticed. It was appended to the favourites list without being
checked, so the picker offered it as selectable, and because no model was stored per account
the prompt path fell back to it too. Opening `/model` would have shown a model that cannot
answer, and choosing it would have failed later with no clue why.

Two places were wrong:

- The favourites builder validated the models read from OpenCode's state file but appended
  the configured model unchecked. It is now filtered against the catalog with everything
  else, and a retired config model is no longer listed.
- The reconciler only validated a *stored* model. With nothing stored, the prompt path uses
  the configured one, so that is what must be checked. It now validates whichever model a
  prompt would actually use and selects a replacement — preferring one this machine used
  recently, then the same provider, then catalog order — and persists the choice to that
  account's slice.

The picker also reconciles when it opens, so an account whose model was retired mid-session
self-heals the next time it looks, instead of waiting for a restart.

Verified against the running server: the retired model disappears from the menu, the
replacement selected was `opencode/deepseek-v4.1-flash-free` — the most recently used model
that still exists — and all ten advertised models remain selectable.

## 0.27.0 — `/model` reaches the picker from any client

The model picker has always been there, but the only way in was to notice that the current
model name in the reply keyboard is itself a button. A collapsed keyboard hides it, a new
account has no reason to guess it, and nothing lists it as a command — so the feature was
effectively invisible.

`/model` opens the same inline picker: favourites, recent, a provider list of everything the
server actually offers, and search. It is available to every account, not only admins, because
the choice is stored in that account's own settings slice and applies to that account's
prompts. The command is published in the per-chat command menu, so it survives the client
restarting with a collapsed keyboard.

Verified against the live server: the picker reports the model currently selected, and the
provider list contains all ten models the server advertises. Forty-eight tests pass, including
that a standard account can use the command and that admin-only commands stay hidden from it.

## 0.26.2 — Updates from a private repository

The repository went private, and every update path broke at once. `github.com/OWNER/REPO/archive/...`
answers 404 for a private repository *before* it considers a credential, and that endpoint does not
accept a token header at all, so no amount of authentication at the same URL can work. Meanwhile no
part of this project sent a credential in the first place: `update.sh`, `install.sh` and the bot's
`update` command all fetched anonymously. It only ever appeared to work because the repository was
public.

All three now resolve a token — `OPENCODE_TELEGRAM_GITHUB_TOKEN`, then a `github-token` file in the
install root, then the credential store git itself uses — and, when one is present, rewrite the
archive URL to `codeload.github.com`, which does accept a bearer token. No token means the old
anonymous behaviour, so a public fork keeps working unchanged. The token is fed to `curl` on stdin
and to `wget` through a mode-`600` config file, not passed as an argument, because arguments are
readable in `ps`.

A 404 from a private repository is also reported as such instead of as a bare status code, since
"not found" and "not allowed" are the same answer from this endpoint.

Verified end to end: `update.sh --check` reaches the private repository and reports the correct
installed and available versions, and `git ls-remote` succeeds through the local credential helper
with no prompt.

## 0.26.1 — Redact a plaintext Postiz token

`mcp add` already writes `Authorization=Bearer {env:POSTIZ_MCP_TOKEN}`, so a token appears
literally in `opencode.jsonc` only when a config was edited by hand, restored from a backup,
or produced by a much older install. Those files get committed, pasted into issues and copied
between machines, so a credential in one is a credential in all of them.

The installer now repairs it: it reads the token from the mode-`600` environment file,
rewrites the header to the environment reference matched by the token value itself so nothing
else in the file is touched, and tightens the file to `600` whether or not it had to change.
The token is never printed. The step is idempotent and a no-op on an already-clean config.

Verified against a config holding a literal token: redacted, `600`, and a second run silent.
Verified against a live server that `{env:POSTIZ_MCP_TOKEN}` still authenticates — the Postiz
MCP reports `connected` with all thirteen tools present.

## 0.26.0 — Authorization, isolation and a restricted social-media agent

A security release. Every finding below was reproduced before it was fixed.

### Fixed

**CRITICAL — session ownership was never checked at use time.**
`isSessionOwned()` existed and had no callers. Ownership filtered the `/sessions` list and
nothing else, so a `session:<id>` callback id was used to fetch a session, read its messages
and then adopt it as the account's current session, with nothing in between checking who it
belonged to. Session ids are not guessable, so this was defence in depth failing rather than
an exploit in progress. Ownership is now checked in `selectSessionById` before the fetch, and
again in `/messages` and the pinned dashboard because those read transcripts.

**CRITICAL — `/projects` was a global list filtered in the menu.**
OpenCode's `/project` endpoint ignores its `directory` argument and answers for the whole
server, which was verified against a running server. There is no scoped query to delegate
to, so the list is now narrowed by the Telegram application before it is returned, and the
same predicate guards the id and worktree lookups.

**CRITICAL — symlink escape in the file browser.**
`isWithinAllowedRoot` compared the raw path with a string prefix, so a symlink inside a root
whose target was outside it was accepted. The realpath-based variant existed, was correct,
and had no callers in the browser paths. Both containment checks are now realpath-based, so
`..` and symlinks are covered by the same test.

**HIGH — the `postiz-social` agent was not restricted.**
It began with `{"permission": "*", "action": "allow"}`, so the social-media agent could run
a shell and edit files, and the restriction was prose in a prompt. It now has a deny-by-default
permission block, and a new `social-media` agent is the one granted to standard accounts.

**HIGH — `postiz_upload_image` read any absolute path.**
It does its own filesystem read, which OpenCode's permission rules do not cover, so it
accepted any path the model named. It is now confined to `POSTIZ_UPLOAD_ALLOWED_ROOTS`,
compared on the realpath.

**HIGH — no role concept existed.**
There was one binary allowlist. There are now three policies: unknown ids are denied, ids in
`TELEGRAM_ALLOWED_USER_ID(S)` are standard, and ids in `TELEGRAM_ADMIN_USER_IDS` are admin.

**HIGH — excluded and dismissed projects stayed reachable.**
`getProjectByWorktree` returned before the exclusion filter and skipped the dismissal check,
so a path hidden from `/projects` was still reachable through `/worktree` and `/open`. Both
now go through the same rule as the list, and the exclusions apply to admins too, since `/`
is excluded precisely so the agent does not run at the filesystem root.

**MEDIUM** — `PERSONA.md` is a single file shared by all accounts, so one account switching
persona changed another's voice. It is now refreshed per turn for the account being served.
Generated images are recorded per account and re-checked on every read and send, so knowing a
filename is not permission. MCP connect/disconnect and agent selection are authorized at the
point of use, not only hidden from the menu.

### Added

- `access-control.ts` — one module that decides who a Telegram account is and what it may
  do. Everything else asks it; no handler decides independently.
- `session-access.ts` — the single choke point for session ownership.
- `image-registry.ts` — per-account ownership of generated files.
- `social-media` agent — deny by default, granted to standard accounts. The Postiz MCP
  tools are granted as the `postiz_*` namespace rather than enumerated, so adding another
  integration is a configuration change in OpenCode plus one line, with no change to the
  Telegram application.
- `TELEGRAM_ADMIN_USER_IDS`, `OPENCODE_TELEGRAM_USER_ROOT`, `POSTIZ_UPLOAD_ALLOWED_ROOTS`.
- 30 security regression tests in `test/security.test.ts`.

### Unchanged, deliberately

OpenCode 1.18.32 remains the bot's backend. 2.0.11 removed the entire root-level API the bot
is written against, and three things it depends on — the ask-the-user flow, session status,
and async prompt — were deleted rather than renamed. Migrating is a rewrite, not a
migration. See README "Why one OpenCode version".

### Known limitations

- OpenCode's permission enforcement is the runtime's own; the deny-by-default block is
  verified at the configuration and resolution layer, against a running server, and follows
  the same mechanism the shipped `plan` agent uses. A live tool call was not exercised,
  because the configured provider refuses out-of-process requests.
- Admins are trusted in this threat model and are not confined to their own workspace.
- Isolation is per-account directories under one Linux user. A restricted account has no
  shell, so the boundary holds; an admin can reach anything the Linux user can.
- The scheduled-task runtime still gates delivery on the process-wide busy check, so a
  deferred result waits for other accounts to finish. Conservative, not wrong.
