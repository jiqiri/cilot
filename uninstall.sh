#!/usr/bin/env bash
set -Eeuo pipefail

# Remove the stack without touching unrelated user data by default.
# Use --purge only after reviewing the paths printed by --dry-run.

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.local/share/cilot}"
OPENCODE_MAIN_BIN_DIR="${OPENCODE_MAIN_BIN_DIR:-$HOME/.opencode/bin}"
CILOT_BIN_DIR="${CILOT_BIN_DIR:-$INSTALL_ROOT/bin}"
OPENCODE_MAIN_CONFIG_DIR="${OPENCODE_MAIN_CONFIG_DIR:-$HOME/.config/opencode}"
CILOT_CONFIG_DIR="${CILOT_CONFIG_DIR:-$HOME/.config/cilot}"
OPENCODE_MAIN_DATA_DIR="${OPENCODE_MAIN_DATA_DIR:-$HOME/.local/share/opencode}"
CILOT_DATA_DIR="${CILOT_DATA_DIR:-$HOME/.local/share/cilot/opencode}"
OPENCODE_MAIN_STATE_DIR="${OPENCODE_MAIN_STATE_DIR:-$HOME/.local/state/opencode}"
CILOT_STATE_DIR="${CILOT_STATE_DIR:-$HOME/.local/state/cilot/opencode}"
OPENCODE_MAIN_CACHE_DIR="${OPENCODE_MAIN_CACHE_DIR:-$HOME/.cache/opencode}"
CILOT_CACHE_DIR="${CILOT_CACHE_DIR:-$HOME/.cache/cilot/opencode}"
USER_SYSTEMD_DIR="${USER_SYSTEMD_DIR:-$HOME/.config/systemd/user}"
BOT_SOURCE_DIR="${BOT_SOURCE_DIR:-$INSTALL_ROOT/bot}"
ADDON_DIR="${ADDON_DIR:-$INSTALL_ROOT/addons}"
ADDON_CONFIG_DIR="${ADDON_CONFIG_DIR:-$CILOT_CONFIG_DIR/addons}"
ADDON_STATE_ROOT="${ADDON_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/cilot/addons}"
CILOT_OPENCODE_CONFIG="${CILOT_OPENCODE_CONFIG:-$CILOT_CONFIG_DIR/opencode/opencode.jsonc}"

DRY_RUN=0
PURGE=0
PURGE_ADDONS=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage: ./uninstall.sh [options]

Options:
  --dry-run       Print actions without changing anything
  --purge         Also remove managed OpenCode/bot configuration and data
  --purge-addons  Also remove add-on configuration and state, including the credentials
                  of every account that was granted an add-on
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
    --purge-addons) PURGE_ADDONS=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $arg" ;;
  esac
done

units=(opencode.service cilot-server.service cilot-bot.service)

if (( ! DRY_RUN && ! ASSUME_YES )); then
  printf 'This will stop and remove the Cilot stack.\n'
  printf 'Managed installation root: %s\n' "$INSTALL_ROOT"
  (( PURGE )) && printf 'Purge mode: managed OpenCode configuration and data will also be removed.\n'
  if (( PURGE_ADDONS || PURGE )); then
    printf 'Add-on purge mode: the following directories will also be removed:\n'
    printf '  %s\n' "$ADDON_CONFIG_DIR" "$ADDON_STATE_ROOT"
  fi
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
  "$INSTALL_ROOT/server.env" \
  "$INSTALL_ROOT/opencode-postiz.env" \
  "$BOT_SOURCE_DIR/.env"; do
  remove_path "$file"
done
remove_path "$BOT_SOURCE_DIR"
remove_path "$ADDON_DIR"
remove_path "$INSTALL_ROOT"

# Add-on configuration holds a profile, a policy and an IMAP app password per account, and
# the state directory holds the read cursors and the audit log. A reinstall should pick
# them up where they were left, so both are kept unless the operator asks for a purge by
# name; `--purge` implies it because that mode already removes the rest of the user data.
if (( PURGE_ADDONS || PURGE )); then
  log 'Removing add-on configuration, credentials and state'
  remove_path "$ADDON_CONFIG_DIR"
  remove_path "$ADDON_STATE_ROOT"

  # The MCP entries outlive the code, because they live in the OpenCode config rather than
  # in the add-on directory. An entry with no server behind it makes OpenCode log a failed
  # start on every session, so a purge by name removes them too.
  if (( ! DRY_RUN )) && command -v node >/dev/null 2>&1 && [[ -f "$CILOT_OPENCODE_CONFIG" ]]; then
    node - "$CILOT_OPENCODE_CONFIG" <<'NODE'
const fs = require("node:fs");

const file = process.argv[2];
let document;
try {
  document = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  // Comments or invalid JSON: leave the operator's file alone rather than rewriting it.
  process.exit(0);
}

const servers = document?.mcp?.servers;
if (!servers || typeof servers !== "object") process.exit(0);

let removed = 0;
for (const [name, entry] of Object.entries(servers)) {
  if (entry && typeof entry === "object" && entry.environment?.CILOT_ADDON_ID) {
    delete servers[name];
    removed += 1;
  }
}
if (removed === 0) process.exit(0);
fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
console.log(`[uninstaller] Removed ${removed} add-on MCP entr${removed === 1 ? "y" : "ies"}`);
NODE
  fi
else
  log "Keeping add-on configuration and state: $ADDON_CONFIG_DIR"
fi

# Installed binaries are removed only with --purge, because they may be shared
# with an existing OpenCode installation.
if (( PURGE )); then
  log 'Removing managed binaries, configuration, and data'
  remove_path "$OPENCODE_MAIN_BIN_DIR/opencode"
  remove_path "$CILOT_BIN_DIR/opencode"
  remove_path "$OPENCODE_MAIN_CONFIG_DIR/plugins/cloudflare-image"
  remove_path "$OPENCODE_MAIN_CONFIG_DIR/skills/cf-image-guidance"
  remove_path "$CILOT_CONFIG_DIR/opencode/tools/image_generate.ts"
  remove_path "$CILOT_CONFIG_DIR/opencode/skills/cf-image-guidance"
  remove_path "$OPENCODE_MAIN_CONFIG_DIR/package.json"
  remove_path "$OPENCODE_MAIN_CONFIG_DIR/package-lock.json"
  remove_path "$OPENCODE_MAIN_CONFIG_DIR/node_modules"
  remove_path "$CILOT_CONFIG_DIR/opencode/package.json"
  remove_path "$CILOT_CONFIG_DIR/opencode/package-lock.json"
  remove_path "$CILOT_CONFIG_DIR/opencode/node_modules"
  remove_path "$OPENCODE_MAIN_DATA_DIR"
  remove_path "$CILOT_DATA_DIR"
  remove_path "$OPENCODE_MAIN_STATE_DIR"
  remove_path "$CILOT_STATE_DIR"
  remove_path "$OPENCODE_MAIN_CACHE_DIR"
  remove_path "$CILOT_CACHE_DIR"
else
  log 'Preserving OpenCode binaries, configuration, and data. Use --purge to remove them.'
fi

log 'Uninstall complete.'
if (( ! PURGE )); then
  log 'The user services and managed runtime files were removed; existing OpenCode data was preserved.'
fi
