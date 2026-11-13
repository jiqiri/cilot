# Mail add-on

Read-only IMAP for Cilot. The agent can list labels, search messages and read one message with
its attachments. There is no send, reply, delete or mark-as-read command: the mailbox is never
written to.

The contract this add-on implements is in [`ADDONS.md`](../../../ADDONS.md). The operational
summary is in [`ARCHITECTURE.md`](../../../ARCHITECTURE.md#add-ons).

## Tools

| Tool as OpenCode sees it | What it does |
| --- | --- |
| `mail_labels` | List the folders or labels this profile may read, with counts |
| `mail_search` | Search within the configured scope; returns uids, sender, subject, date, snippet |
| `mail_read` | Read one message; attachments are listed or downloaded to the workspace |
| `mail_ack` | Record that messages were delivered, so a scheduled task can report only new mail |

Names are prefixed by OpenCode with the MCP server name, which is the add-on id.

## What an admin configures

Everything. The account being served never changes its own scope or credentials.

| Field | Meaning |
| --- | --- |
| `mode` | `labels` reads only the configured names; `mailbox` reads any folder the server lists |
| `labels` | Labels or folders allowed in `labels` mode (combined with `folders`) |
| `folders` | Folders allowed in `labels` mode; the default `["INBOX"]` is a usable scope |
| `maxResults` | Results per search, 1–100 |
| `sinceDays` | How far back a search looks, 1–365 |
| `body` | `text` returns a truncated body; `none` returns metadata only |
| `attachments` | `none`, `list` or `download`; a call can ask for less than the profile allows, never more |
| `attachmentMaxMB` | Largest attachment to download, 1–50; a call is capped at 25 MB total |

Credentials are per account, in `users/<id>/secrets.env` under the add-on config root:

```text
MAIL_IMAP_HOST=imap.example.com
MAIL_IMAP_PORT=993
MAIL_IMAP_USER=you@example.com
MAIL_IMAP_PASSWORD=app-password
```

Port 993 is TLS; port 143 requires STARTTLS and is refused otherwise. Use an app password, not
the account password. XOAUTH2 is not implemented in 1.0.0.

## Layout

```text
src/server.ts       stdio loop and --selftest
src/protocol.ts     JSON-RPC framing; tool failures are results, not transport errors
src/tools.ts        tool schemas and the audit wrapper
src/shared/         identity, policy, profile, secrets, audit, rate limiting
src/mail/           IMAP access, scope checks, attachments, notification cursor
test/               Node test runner cases, run against dist/
dist/               committed build output (the installer has no TypeScript toolchain)
```

## Identity and authorization

- The account is `realpath(process.cwd())` under `CILOT_USER_ROOT`, first numeric segment.
  A shared folder or the operator's own directory is `unknown_account`, never a guess.
- `policy.json` is re-read on every call. No row and `default: "admin-only"` means `off`.
- The profile is validated against `addon.json` on every read. A value that violates the schema
  is `invalid_config`, never a silent fallback.
- One connection per call. The audit log records the account, tool, result code and counts —
  never a query, a sender, a subject or a body.

## Build and test

```bash
npm ci            # dev dependencies, needed to build and test
npm run build     # tsc -> dist/
npm test          # build, then node --test "test/*.test.mjs"
```

`npm ci --omit=dev` is what the installer runs; it uses the committed `dist/` and never builds.

## Self-test

```bash
node dist/server.js --selftest
```

Runs in an account's workspace with the add-on environment set, checks identity, grant, profile,
credentials and a folder listing, then prints one JSON line:

```json
{ "ok": true, "account": "1084045244", "mode": "labels", "folders": 6, "unread": 3 }
```

`/addons` → Test runs exactly this.
