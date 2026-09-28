#!/usr/bin/env bash
# Update the Telegram bot from the repository it was installed from.
#
# The source is read from payload-source.txt, which the installer writes. That is what
# keeps a fork updating from the fork: nothing here is hardcoded to an upstream owner, so
# a machine installed from your own repository never pulls from someone else's.
#
# Bot settings are preserved. The bot's own update command replaces only what belongs to
# the repository and copies .env, settings.json and settings.json.bak back afterwards, so
# the Telegram token, the OpenCode credentials and per-account state survive.
#
# Usage:
#   ./update.sh            update and restart
#   ./update.sh --check    report whether a newer version exists, change nothing
#   ./update.sh --no-restart  update but leave the service running the old build

set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.local/share/opencode-telegram-installer}"
BOT_SOURCE_DIR="${BOT_SOURCE_DIR:-$INSTALL_ROOT/opencode-telegram-bot}"
SERVICE_NAME="${SERVICE_NAME:-opencode-telegram-bot.service}"
SOURCE_FILE="$INSTALL_ROOT/payload-source.txt"

CHECK_ONLY=0
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --no-restart) RESTART=0 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf '[update] Unknown option: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

log() { printf '[update] %s\n' "$*"; }
die() { printf '[update] ERROR: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required but was not found on PATH."

# The bot may be running against a node that the installer placed outside the default PATH.
if ! [[ -x "$BOT_SOURCE_DIR/../bin/node" ]]; then
  INSTALLED_NODE="$(dirname "$(command -v node)")/node"
else
  INSTALLED_NODE="$INSTALL_ROOT/bin/node"
fi
[[ -x "$INSTALLED_NODE" ]] || die "Cannot find the node binary."

# The bot searches for payload-source.txt itself, but the install root is known here, so
# hand it over rather than relying on it being found next to the bot directory.
export OPENCODE_TELEGRAM_INSTALL_ROOT="$INSTALL_ROOT"

NODE_BIN="$INSTALLED_NODE"
CLI="$BOT_SOURCE_DIR/dist/cli.js"
[[ -f "$CLI" ]] || die "Bot build not found at $CLI. Run the installer first."

# Read the recorded source so the operator can see where this is about to pull from.
if [[ -f "$SOURCE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$SOURCE_FILE"
  log "Repository: ${repo:-unknown}"
  log "Branch:     ${branch:-unknown}"
  log "Archive:    ${url:-unknown}"
else
  log "No payload-source.txt found, the bot will use its built-in default."
fi

log "Installed version: $(node -e "console.log(require('$BOT_SOURCE_DIR/package.json').version)" 2>/dev/null || echo unknown)"

if (( CHECK_ONLY )); then
  log "Checking for a newer release..."
  "$NODE_BIN" "$CLI" update --check
  exit $?
fi

log "Updating..."
"$NODE_BIN" "$CLI" update

if (( RESTART )); then
  log "Restarting $SERVICE_NAME..."
  systemctl --user restart "$SERVICE_NAME"
  sleep 3
  if systemctl --user is-active --quiet "$SERVICE_NAME"; then
    log "Done, service is active."
  else
    log "The service did not come back up. Check: journalctl --user -u $SERVICE_NAME -n 50"
    exit 1
  fi
else
  log "Done, service not restarted. Run: systemctl --user restart $SERVICE_NAME"
fi
