#!/usr/bin/env bash
# Update the Telegram bot from the repository it was installed from.
#
# This script does the work itself rather than delegating to the bot's own `update`
# subcommand. That subcommand only exists from v0.25.4 onwards, so delegating would make
# the first update impossible on any installation made before it: the script would call a
# command the installed build has never heard of. Doing it here means an old install can
# bootstrap itself, and there is a single code path to reason about.
#
# Settings are preserved. .env, settings.json and settings.json.bak are copied aside and
# put back, so the Telegram token, the OpenCode credentials and per-account state survive.
#
# Where updates come from:
#   1. OPENCODE_TELEGRAM_UPDATE_URL, for a one-off override.
#   2. payload-source.txt, written by the installer. This is what keeps a fork updating
#      from the fork; nothing here is tied to an upstream owner.
#   3. The built-in default, with a warning.
#
# Usage:
#   ./update.sh              update and restart
#   ./update.sh --check      report whether a newer version exists, change nothing
#   ./update.sh --no-restart update, leave the service running the old build
#   ./update.sh --repo owner/name [--branch name]   record a different source first

set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.local/share/opencode-telegram-installer}"
BOT_SOURCE_DIR="${BOT_SOURCE_DIR:-$INSTALL_ROOT/opencode-telegram-bot}"
SERVICE_NAME="${SERVICE_NAME:-opencode-telegram-bot.service}"
SOURCE_FILE="$INSTALL_ROOT/payload-source.txt"
DEFAULT_REPO="${DEFAULT_REPO:-jiqiri/opencode-telegram-installer}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

log() { printf '[update] %s\n' "$*"; }
die() { printf '[update] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,19p' "$0" | sed 's/^#\{1,\} \{0,1\}//'
  exit 0
}

# ---------------------------------------------------------------- arguments
CHECK_ONLY=0
RESTART=1
RECORD_REPO=""
RECORD_BRANCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --no-restart) RESTART=0; shift ;;
    --repo)
      [[ $# -ge 2 ]] || die "--repo needs a value, for example your-org/your-fork"
      RECORD_REPO="$2"; shift 2 ;;
    --branch)
      [[ $# -ge 2 ]] || die "--branch needs a value"
      RECORD_BRANCH="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) printf '[update] Unknown option: %s\n' "$1" >&2; usage ;;
  esac
done

mkdir -p "$INSTALL_ROOT"

# ------------------------------------------------------- resolve the source
archive_url() {
  local override="${OPENCODE_TELEGRAM_UPDATE_URL:-}"
  if [[ -n "$override" ]]; then
    printf '%s' "$override"
    return
  fi
  if [[ -f "$SOURCE_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$SOURCE_FILE"
    if [[ -n "${url:-}" ]]; then
      printf '%s' "$url"
      return
    fi
  fi
  printf 'https://github.com/%s/archive/refs/heads/%s.tar.gz' \
    "${PAYLOAD_REPO:-$DEFAULT_REPO}" "${PAYLOAD_BRANCH:-$DEFAULT_BRANCH}"
}

# Record the source so later runs, and the bot's own update command, agree on it.
record_source() {
  local repo="$1" branch="$2"
  local url="https://github.com/$repo/archive/refs/heads/$branch.tar.gz"
  cat >"$SOURCE_FILE" <<EOF
repo=$repo
branch=$branch
url=$url
EOF
  chmod 644 "$SOURCE_FILE"
  log "Recorded update source: $repo ($branch)"
}

if [[ -n "$RECORD_REPO" ]]; then
  record_source "$RECORD_REPO" "${RECORD_BRANCH:-$DEFAULT_BRANCH}"
fi

if [[ ! -f "$SOURCE_FILE" ]]; then
  # An installation made before payload-source.txt existed. Self-heal rather than warn on
  # every run, and say so, because this is the moment a fork should be recorded.
  log "No payload-source.txt found, recording the default source."
  log "If this machine was installed from your own fork, re-run with:"
  log "  ./update.sh --repo your-org/your-fork"
  record_source "$DEFAULT_REPO" "$DEFAULT_BRANCH"
fi

# shellcheck disable=SC1090
source "$SOURCE_FILE"
log "Repository: ${repo:-unknown}"
log "Branch:     ${branch:-unknown}"
log "Archive:    ${url:-unknown}"

[[ -d "$BOT_SOURCE_DIR" ]] || die "Bot directory not found: $BOT_SOURCE_DIR"

# --------------------------------------------------------------- toolchain
if ! command -v node >/dev/null 2>&1; then
  if [[ -x "$INSTALL_ROOT/bin/node" ]]; then
    export PATH="$INSTALL_ROOT/bin:$PATH"
  else
    die "node is required but was not found on PATH."
  fi
fi
command -v npm >/dev/null 2>&1 || die "npm is required but was not found on PATH."

fetch() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$dest"
  else
    die "Neither curl nor wget is available."
  fi
}

current_version() {
  node -e "try{console.log(require('$BOT_SOURCE_DIR/package.json').version||'unknown')}catch(e){console.log('unknown')}"
}

log "Installed version: $(current_version)"

# ------------------------------------------------------------------- check
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

if ! fetch "$(archive_url)" "$WORKDIR/payload.tar.gz"; then
  die "Download failed from $(archive_url)"
fi
command -v tar >/dev/null 2>&1 || die "tar is required but was not found on PATH."
tar -xzf "$WORKDIR/payload.tar.gz" -C "$WORKDIR" || die "Could not unpack the archive."

PAYLOAD_DIR="$(find "$WORKDIR" -mindepth 1 -maxdepth 1 -type d -name '*opencode-telegram-installer*' -print -quit)/payload/opencode-telegram-bot"
[[ -d "$PAYLOAD_DIR" ]] || die "Downloaded archive does not contain the installer payload."
[[ -f "$PAYLOAD_DIR/package.json" ]] || die "Payload is missing package.json."

incoming_version="$(node -e "try{console.log(require('$PAYLOAD_DIR/package.json').version||'unknown')}catch(e){console.log('unknown')}")"
log "Available version: $incoming_version"

# The payload carries more than the bot's package.json: personas, skills, agent guidance
# and tools all live in it, and those change without the bot version moving. Deciding on
# version alone would silently skip most published updates, so compare the tracked files
# and use the version only for reporting.
payload_fingerprint() {
  local dir="$1" sum_tool=""
  if command -v sha256sum >/dev/null 2>&1; then
    sum_tool="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    sum_tool="shasum -a 256"
  else
    printf 'nofingerprint'
    return
  fi
  (cd "$dir" && find . -type f \( -name '*.ts' -o -name '*.json' -o -name '*.md' -o -name '*.js' \) \
      -not -path './node_modules/*' -not -path './dist/*' -not -path './logs/*' \
      -not -path './run/*' -not -name 'package-lock.json' \
      -not -name '.env' -not -name 'settings.json' -not -name 'settings.json.bak' \
      | LC_ALL=C sort | xargs $sum_tool 2>/dev/null | sha256sum | cut -d' ' -f1)
}

incoming_fingerprint="$(payload_fingerprint "$PAYLOAD_DIR")"

# Comparing the two trees directly is unreliable: the installed tree carries operator
# files and build output the payload does not. The fingerprint recorded when the last
# update applied is the reliable baseline. Only fall back to hashing the installed tree
# on an installation that predates this file.
FINGERPRINT_FILE="$INSTALL_ROOT/payload-fingerprint.txt"
if [[ -f "$FINGERPRINT_FILE" ]]; then
  installed_fingerprint="$(cat "$FINGERPRINT_FILE")"
else
  installed_fingerprint="$(payload_fingerprint "$BOT_SOURCE_DIR")"
fi

if [[ "$incoming_fingerprint" == "nofingerprint" || "$installed_fingerprint" == "nofingerprint" ]]; then
  if [[ "$incoming_version" == "$(current_version)" ]]; then
    log "Cannot fingerprint the source, assuming up to date."
    exit 0
  fi
  CHANGED=1
elif [[ "$incoming_fingerprint" == "$installed_fingerprint" ]]; then
  CHANGED=0
else
  CHANGED=1
fi

if (( CHECK_ONLY )); then
  if (( CHANGED )); then
    log "Update available: $(current_version) -> $incoming_version (source differs)"
  else
    log "Already up to date ($(current_version))."
  fi
  exit 0
fi

if (( ! CHANGED )); then
  log "Already on $incoming_version and the source matches, nothing to do."
  if (( RESTART )); then
    log "Restarting $SERVICE_NAME anyway."
    systemctl --user restart "$SERVICE_NAME"
  fi
  exit 0
fi

# ------------------------------------------------------------------ update
PRESERVE=(.env settings.json settings.json.bak)
PRESERVED_DIR="$WORKDIR/preserved"
mkdir -p "$PRESERVED_DIR"
PRESERVED=()
for name in "${PRESERVE[@]}"; do
  if [[ -f "$BOT_SOURCE_DIR/$name" ]]; then
    cp -a "$BOT_SOURCE_DIR/$name" "$PRESERVED_DIR/$name"
    PRESERVED+=("$name")
  fi
done
(( ${#PRESERVED[@]} > 0 )) && log "Preserved: ${PRESERVED[*]}"

# Reinstalling is what costs minutes, so it is gated on the dependency set. The build is
# not: `npm run build` is tsc over src/, so a change to any TypeScript file needs it even
# when package.json is untouched. Gating both on dependencies meant an update that only
# changed source copied the new .ts files and left dist/ stale, so the bot kept running the
# previous build and the update looked successful while doing nothing.
DEPS_CHANGED=0
for f in package.json package-lock.json; do
  if ! cmp -s "$PAYLOAD_DIR/$f" "$BOT_SOURCE_DIR/$f" 2>/dev/null; then
    DEPS_CHANGED=1
    break
  fi
done
[[ -d "$BOT_SOURCE_DIR/node_modules" ]] || DEPS_CHANGED=1
[[ -f "$BOT_SOURCE_DIR/dist/cli.js" ]] || DEPS_CHANGED=1

if (( DEPS_CHANGED )); then
  log "Dependencies changed, reinstalling..."
  rm -rf "$BOT_SOURCE_DIR/dist" "$BOT_SOURCE_DIR/node_modules"
else
  log "Dependencies unchanged, keeping node_modules."
fi

cp -a "$PAYLOAD_DIR/." "$BOT_SOURCE_DIR/"
for name in "${PRESERVE[@]}"; do
  rm -f "$BOT_SOURCE_DIR/$name"
done
for name in "${PRESERVED[@]}"; do
  cp -a "$PRESERVED_DIR/$name" "$BOT_SOURCE_DIR/$name"
done

# Reached only when the source actually differs, so the build always runs. A missing tsc or
# a type error must stop the update here rather than leave a half-updated tree that still
# starts, because the failure would otherwise only appear as odd behaviour later.
if (( DEPS_CHANGED )); then
  log "Installing dependencies..."
  (cd "$BOT_SOURCE_DIR" && npm ci --no-audit --no-fund) \
    || die "npm ci failed. The previous source is still in place; check the output above."
fi
log "Building..."
if ! (cd "$BOT_SOURCE_DIR" && npm run build); then
  die "The build failed, so dist/ is stale or missing. The previous dist was not removed unless dependencies changed; check the output above."
fi

printf '%s' "$incoming_fingerprint" >"$FINGERPRINT_FILE"
chmod 644 "$FINGERPRINT_FILE"
log "Updated to $(current_version)"

if (( RESTART )); then
  log "Restarting $SERVICE_NAME..."
  systemctl --user restart "$SERVICE_NAME"
  sleep 3
  if systemctl --user is-active --quiet "$SERVICE_NAME"; then
    log "Done, service is active."
  else
    log "The service did not come back up: journalctl --user -u $SERVICE_NAME -n 50"
    exit 1
  fi
else
  log "Done, service not restarted. Run: systemctl --user restart $SERVICE_NAME"
fi
