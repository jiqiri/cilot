#!/usr/bin/env bash
set -Eeuo pipefail

# Remove the stack without touching unrelated user data by default.
# Use --purge only after reviewing the paths printed by --dry-run.

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.local/share/opencode-telegram-installer}"
OPENCODE_MAIN_BIN_DIR="${OPENCODE_MAIN_BIN_DIR:-$HOME/.opencode/bin}"
OPENCODE_TELEGRAM_BIN_DIR="${OPENCODE_TELEGRAM_BIN_DIR:-$HOME/.opencode-telegram/bin}"
OPENCODE_MAIN_CONFIG_DIR="${OPENCODE_MAIN_CONFIG_DIR:-$HOME/.config/opencode}"
OPENCODE_TELEGRAM_CONFIG_DIR="${OPENCODE_TELEGRAM_CONFIG_DIR:-$HOME/.config/opencode-telegram-server}"
OPENCODE_MAIN_DATA_DIR="${OPENCODE_MAIN_DATA_DIR:-$HOME/.local/share/opencode}"
OPENCODE_TELEGRAM_DATA_DIR="${OPENCODE_TELEGRAM_DATA_DIR:-$HOME/.local/share/opencode-telegram-server}"
OPENCODE_MAIN_STATE_DIR="${OPENCODE_MAIN_STATE_DIR:-$HOME/.local/state/opencode}"
OPENCODE_TELEGRAM_STATE_DIR="${OPENCODE_TELEGRAM_STATE_DIR:-$HOME/.local/state/opencode-telegram-server}"
OPENCODE_MAIN_CACHE_DIR="${OPENCODE_MAIN_CACHE_DIR:-$HOME/.cache/opencode}"
OPENCODE_TELEGRAM_CACHE_DIR="${OPENCODE_TELEGRAM_CACHE_DIR:-$HOME/.cache/opencode-telegram-server}"
USER_SYSTEMD_DIR="${USER_SYSTEMD_DIR:-$HOME/.config/systemd/user}"
BOT_SOURCE_DIR="${BOT_SOURCE_DIR:-$INSTALL_ROOT/opencode-telegram-bot}"

DRY_RUN=0
PURGE=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage: ./uninstall.sh [options]

Options:
  --dry-run       Print actions without changing anything
  --purge         Also remove managed OpenCode/bot configuration and data
  --yes           Do not ask for confirmation
  -h, --help      Show this help
EOF
}

log() { printf '[uninstaller] %s\n' "$*"; }
die() { printf '[uninstaller] ERROR: %s\n' "$*" >&2; exit 1; }
run() {
  if (( DRY_RUN )); then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}
remove_path() {
  local path="$1"
  [[ -n "$path" && "$path" != "/" ]] || die "Refusing to remove unsafe path: $path"
  if [[ -e "$path" || -L "$path" ]]; then
    run rm -rf -- "$path"
  fi
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --purge) PURGE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $arg" ;;
  esac
done

units=(opencode.service opencode-telegram-server.service opencode-telegram-bot.service)

if (( ! DRY_RUN && ! ASSUME_YES )); then
  printf 'This will stop and remove the OpenCode Telegram stack.\n'
  printf 'Managed installation root: %s\n' "$INSTALL_ROOT"
  (( PURGE )) && printf 'Purge mode: managed OpenCode configuration and data will also be removed.\n'
  read -r -p 'Continue? [y/N] ' answer
  [[ "$answer" == [yY] ]] || { log 'Cancelled.'; exit 0; }
fi

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  log 'Stopping and disabling user services'
  run systemctl --user disable --now "${units[@]}" || true
else
  log 'User systemd is unavailable; skipping service stop commands.'
fi

for unit in "${units[@]}"; do
  remove_path "$USER_SYSTEMD_DIR/$unit"
done
run systemctl --user daemon-reload || true
run systemctl --user reset-failed "${units[@]}" || true

# Runtime files created by install.sh.
for file in \
  "$INSTALL_ROOT/opencode-main.env" \
  "$INSTALL_ROOT/opencode-cloudflare.env" \
  "$INSTALL_ROOT/opencode-telegram-server.env" \
  "$INSTALL_ROOT/opencode-postiz.env" \
  "$BOT_SOURCE_DIR/.env"; do
  remove_path "$file"
done
remove_path "$BOT_SOURCE_DIR"
remove_path "$INSTALL_ROOT"

# Installed binaries are removed only with --purge, because they may be shared
# with an existing OpenCode installation.
if (( PURGE )); then
  log 'Removing managed binaries, configuration, and data'
  remove_path "$OPENCODE_MAIN_BIN_DIR/opencode"
  remove_path "$OPENCODE_TELEGRAM_BIN_DIR/opencode"
  remove_path "$OPENCODE_MAIN_CONFIG_DIR/plugins/cloudflare-image"
  remove_path "$OPENCODE_MAIN_CONFIG_DIR/skills/cf-image-guidance"
  remove_path "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/tools/image_generate.ts"
  remove_path "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/skills/cf-image-guidance"
  remove_path "$OPENCODE_MAIN_CONFIG_DIR/package.json"
  remove_path "$OPENCODE_MAIN_CONFIG_DIR/package-lock.json"
  remove_path "$OPENCODE_MAIN_CONFIG_DIR/node_modules"
  remove_path "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/package.json"
  remove_path "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/package-lock.json"
  remove_path "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/node_modules"
  remove_path "$OPENCODE_MAIN_DATA_DIR"
  remove_path "$OPENCODE_TELEGRAM_DATA_DIR"
  remove_path "$OPENCODE_MAIN_STATE_DIR"
  remove_path "$OPENCODE_TELEGRAM_STATE_DIR"
  remove_path "$OPENCODE_MAIN_CACHE_DIR"
  remove_path "$OPENCODE_TELEGRAM_CACHE_DIR"
else
  log 'Preserving OpenCode binaries, configuration, and data. Use --purge to remove them.'
fi

log 'Uninstall complete.'
if (( ! PURGE )); then
  log 'The user services and managed runtime files were removed; existing OpenCode data was preserved.'
fi
