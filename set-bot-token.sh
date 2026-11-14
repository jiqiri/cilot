#!/usr/bin/env bash
set -Eeuo pipefail

# Change the Telegram bot token on an installed Cilot, without re-running the installer.
#
# The token lives in two files on purpose: `~/.config/cilot/install.env` is what a later
# `./install.sh` reads, and the bot's own `.env` is what `cilot-bot.service` loads. Updating
# only one of them means the next install silently brings the old bot back, so this script
# writes both and restarts the unit.
#
# The token is never echoed, never written to a log, and never passed in `ps`: the `getMe`
# check sends it through curl's stdin config rather than the command line.

SETTINGS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/cilot"
DEFAULT_ENV_FILE="$SETTINGS_DIR/install.env"
INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.local/share/cilot}"

INSTALL_ENV_FILE="${INSTALL_ENV_FILE:-$DEFAULT_ENV_FILE}"
BOT_ENV_FILE="${BOT_ENV_FILE:-}"
TOKEN="${TELEGRAM_BOT_TOKEN:-}"
VERIFY=1
RESTART=1
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: ./set-bot-token.sh [options] [TOKEN]

Change the Telegram bot token of an installed Cilot.

The token is read from the argument, from TELEGRAM_BOT_TOKEN, or from a hidden prompt.
It is written to ~/.config/cilot/install.env and to the bot's .env, then cilot-bot.service
is restarted. A token is a credential: it is never printed back.

Options:
  --env-file PATH   installer settings to update (default: ~/.config/cilot/install.env)
  --bot-env PATH    bot .env to update (default: discovered from cilot-bot.service)
  --no-verify       skip the Telegram getMe check (offline, or a token you cannot test yet)
  --no-restart      write the files without restarting cilot-bot.service
  --dry-run         print what would change, without writing or restarting
  -h, --help        show this message

Examples:
  ./set-bot-token.sh
  ./set-bot-token.sh 123456789:AAH...
  TELEGRAM_BOT_TOKEN=... ./set-bot-token.sh --no-restart
EOF
}

log() {
  printf '[token] %s\n' "$*"
}

die() {
  printf '[token] %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || die "--env-file needs a path."
      INSTALL_ENV_FILE="$2"; shift 2 ;;
    --bot-env)
      [[ $# -ge 2 ]] || die "--bot-env needs a path."
      BOT_ENV_FILE="$2"; shift 2 ;;
    --no-verify) VERIFY=0; shift ;;
    --no-restart) RESTART=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) die "Unknown option: $1 (try --help)" ;;
    *) TOKEN="$1"; shift ;;
  esac
done

# `systemctl --user cat` includes drop-ins, and entries may be prefixed with `-` to mean
# "ignore when missing". Only a file literally named `.env` is the bot's environment; the
# shared `server.env` also matches EnvironmentFile and must not be rewritten.
discover_bot_env() {
  if [[ -n "$BOT_ENV_FILE" ]]; then
    printf '%s' "$BOT_ENV_FILE"
    return 0
  fi

  local candidate=""
  if command -v systemctl >/dev/null 2>&1; then
    candidate="$(systemctl --user cat cilot-bot.service 2>/dev/null \
      | sed -n 's/^EnvironmentFile=//p' \
      | sed 's/^-//' \
      | grep -E '(^|/)\.env$' \
      | head -n 1 || true)"
  fi
  if [[ -n "$candidate" ]]; then
    printf '%s' "$candidate"
    return 0
  fi

  if [[ -f "$INSTALL_ROOT/bot/.env" ]]; then
    printf '%s' "$INSTALL_ROOT/bot/.env"
    return 0
  fi

  return 1
}

# Replace the key in place, keeping comments and every other line. A missing key is
# appended, so a token-only file is still valid.
set_key() {
  local file="$1" key="$2" value="$3" directory tmp
  directory="$(dirname "$file")"
  mkdir -p "$directory"
  chmod 700 "$directory" 2>/dev/null || true

  tmp="$(mktemp "$directory/.${key}.XXXXXX")"
  if [[ -f "$file" ]]; then
    awk -v k="$key" -v v="$value" '
      $0 ~ ("^" k "=") { if (!done) { print k "=" v; done = 1 } next }
      { print }
      END { if (!done) print k "=" v }
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi

  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

# Returns the response body on success, and a non-zero status on a rejected token.
verify_token() {
  local token="$1" body
  body="$(printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$token" \
    | curl -fsS --max-time 10 -K - 2>/dev/null || true)"
  case "$body" in
    *'"ok":true'*) printf '%s' "$body" ;;
    *) return 1 ;;
  esac
}

if [[ -z "$TOKEN" ]]; then
  [[ -t 0 ]] || die "No token given. Pass it as an argument or set TELEGRAM_BOT_TOKEN."
  printf 'Bot token (hidden): '
  IFS= read -r -s TOKEN
  printf '\n'
fi

# Trim surrounding whitespace from a copy-paste.
TOKEN="${TOKEN#"${TOKEN%%[![:space:]]*}"}"
TOKEN="${TOKEN%"${TOKEN##*[![:space:]]}"}"

if ! [[ "$TOKEN" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{20,}$ ]]; then
  die "That does not look like a Telegram bot token (expected <id>:<secret>). Nothing changed."
fi

# Creating a partial install.env would shadow the real settings the next time the installer
# runs, so a missing file is an error rather than something to invent.
[[ -f "$INSTALL_ENV_FILE" ]] || die "No installer settings at $INSTALL_ENV_FILE. Pass --env-file PATH."

bot_env="$(discover_bot_env)" || die "Could not find the bot .env. Pass --bot-env PATH."
[[ -n "$bot_env" ]] || die "Could not find the bot .env. Pass --bot-env PATH."

if [[ "$bot_env" == "$INSTALL_ENV_FILE" ]]; then
  die "The installer settings and the bot .env resolve to the same file: $bot_env"
fi

username=""
if (( VERIFY )); then
  if ! body="$(verify_token "$TOKEN")"; then
    die "Telegram rejected the token (getMe). Nothing changed. Use --no-verify to write it anyway."
  fi
  username="$(printf '%s' "$body" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p' | head -n 1)"
  log "Token belongs to @${username:-unknown}."
else
  log "Skipping the Telegram check (--no-verify)."
fi

if (( DRY_RUN )); then
  log "Would update: $INSTALL_ENV_FILE"
  log "Would update: $bot_env"
  (( RESTART )) && log "Would restart: cilot-bot.service"
  log "Dry run: nothing written."
  exit 0
fi

set_key "$INSTALL_ENV_FILE" TELEGRAM_BOT_TOKEN "$TOKEN"
log "Updated $INSTALL_ENV_FILE"
set_key "$bot_env" TELEGRAM_BOT_TOKEN "$TOKEN"
log "Updated $bot_env"

if (( ! RESTART )); then
  log "Not restarting (--no-restart). Run: systemctl --user restart cilot-bot.service"
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1; then
  log "systemctl is unavailable; restart cilot-bot.service by hand."
  exit 0
fi

log "Restarting cilot-bot.service"
systemctl --user restart cilot-bot.service || die "The files are updated, but the restart failed. Check: systemctl --user status cilot-bot.service"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if systemctl --user is-active --quiet cilot-bot.service; then
    log "cilot-bot.service is active${username:+ as @$username}."
    exit 0
  fi
  sleep 1
done

die "The files are updated, but cilot-bot.service did not become active. Check: journalctl --user -u cilot-bot.service -n 50"
