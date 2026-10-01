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
