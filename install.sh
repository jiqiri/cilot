#!/usr/bin/env bash
set -Eeuo pipefail

# Replace the placeholders below before running this script, or export the same
# names in the shell. Do not commit real credentials.
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-REPLACE_WITH_TELEGRAM_BOT_TOKEN}"
TELEGRAM_ALLOWED_USER_ID="${TELEGRAM_ALLOWED_USER_ID:-REPLACE_WITH_TELEGRAM_ALLOWED_USER_ID}"
CF_WORKERS_AI_ACCOUNT="${CF_WORKERS_AI_ACCOUNT:-REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID}"
CF_WORKERS_AI_TOKEN="${CF_WORKERS_AI_TOKEN:-REPLACE_WITH_CLOUDFLARE_API_TOKEN}"
POSTIZ_MCP_URL="${POSTIZ_MCP_URL:-REPLACE_WITH_POSTIZ_MCP_URL}"
POSTIZ_MCP_TOKEN="${POSTIZ_MCP_TOKEN:-REPLACE_WITH_POSTIZ_BEARER_TOKEN}"
if [[ "$POSTIZ_MCP_URL" == *REPLACE_WITH* ]]; then
  POSTIZ_MCP_URL=""
fi
if [[ "$POSTIZ_MCP_TOKEN" == *REPLACE_WITH* ]]; then
  POSTIZ_MCP_TOKEN=""
fi
OPENCODE_MODEL_PROVIDER="${OPENCODE_MODEL_PROVIDER:-opencode}"
OPENCODE_MODEL_ID="${OPENCODE_MODEL_ID:-space-bunny-free}"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PAYLOAD_DIR="$SCRIPT_DIR/payload"
PAYLOAD_ARCHIVE_URL="${PAYLOAD_ARCHIVE_URL:-https://github.com/jiqiri/opencode-telegram-installer/archive/refs/heads/main.tar.gz}"
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
OPENCODE_MAIN_URL="${OPENCODE_MAIN_URL:-http://127.0.0.1:5100}"
OPENCODE_TELEGRAM_URL="${OPENCODE_TELEGRAM_URL:-http://127.0.0.1:4096}"
OPENCODE_MAIN_VERSION="2.0.11"
OPENCODE_TELEGRAM_VERSION="1.18.32"

log() { printf '[installer] %s\n' "$*"; }
die() { printf '[installer] ERROR: %s\n' "$*" >&2; exit 1; }

require_command() { command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"; }

# The bot declares engines.node ^22.14.0 || ^23.6.0 || >=24. Distribution packages are
# routinely older than that: Debian 12 ships Node 18 and Ubuntu 22.04 ships Node 12, and
# "apt install npm" would therefore install a toolchain that fails much later with a
# confusing build error. Node is fetched from nodejs.org into INSTALL_ROOT instead, which
# needs no root, leaves the system alone, and matches how the OpenCode binaries are already
# installed below.
NODE_VERSION="${NODE_VERSION:-22.20.0}"

# Downloader used for every fetch. ensure_bootstrap_tools downgrades this to wget when
# curl has to be installed first, or cannot be installed at all.
FETCH_CMD="curl"

SUDO=""
detect_sudo() {
  SUDO=""
  [[ "$(id -u)" == "0" ]] && return 0
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO="sudo -n"
    return 0
  fi
  return 1
}

# Installs packages with whichever manager the machine has. Never prompts for a password:
# sudo -n fails immediately when authentication would be required, so a machine without
# passwordless sudo reports that it needs manual setup instead of hanging on a hidden
# prompt that the user cannot see.
pkg_install() {
  detect_sudo || {
    log "No root or passwordless sudo available, cannot install: $*"
    return 1
  }
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -qq >/dev/null 2>&1
    $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y -q "$@"
  elif command -v yum >/dev/null 2>&1; then
    $SUDO yum install -y -q "$@"
  elif command -v zypper >/dev/null 2>&1; then
    $SUDO zypper --non-interactive install "$@"
  elif command -v pacman >/dev/null 2>&1; then
    $SUDO pacman -Sy --noconfirm "$@"
  elif command -v apk >/dev/null 2>&1; then
    $SUDO apk add --no-cache "$@"
  elif command -v brew >/dev/null 2>&1; then
    brew install "$@"
  else
    log "No supported package manager found."
    return 1
  fi
}

# curl and tar are needed before anything can be downloaded or unpacked, so they are the
# only hard blockers. Everything else is installed without root.
ensure_bootstrap_tools() {
  local missing=() tool_name
  for tool_name in curl tar; do
    command -v "$tool_name" >/dev/null 2>&1 || missing+=("$tool_name")
  done

  if [[ ${#missing[@]} -eq 0 ]]; then
    return 0
  fi

  # Without curl there is no downloader yet, so a different one has to bootstrap the rest.
  local downloader="curl"
  if ! command -v curl >/dev/null 2>&1; then
    if command -v wget >/dev/null 2>&1; then
      log "curl is missing but wget is available, using it to bootstrap"
      downloader="wget"
    else
      pkg_install curl ca-certificates || true
      command -v curl >/dev/null 2>&1 || die "curl is missing and could not be installed. Install curl and re-run."
    fi
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    log "Installing missing tools: ${missing[*]}"
    pkg_install "${missing[@]}" ca-certificates || true
  fi

  for tool_name in "${missing[@]}"; do
    command -v "$tool_name" >/dev/null 2>&1 || die "Could not install $tool_name. Install it manually and re-run."
  done
  command -v openssl >/dev/null 2>&1 || pkg_install openssl || true
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate the server password."
  FETCH_CMD="$downloader"
}

# This installer targets a normal user account with a user systemd session. Running it
# under sudo would set HOME to /root, so everything would install into /root's home, the
# units would be written for root's systemd, and `systemctl --user` would either fail or
# manage the wrong account. Package installs are the only part that ever needs privilege,
# and those go through sudo -n from inside the script.
refuse_root() {
  [[ "$(id -u)" == "0" ]] || return 0
  cat >&2 <<'EOF'

[installer] ERROR: do not run the installer as root.

This installs into your own home directory and registers user systemd services.
Under sudo, HOME becomes /root, so it would install there and the units would
belong to the wrong account.

Run it as your normal user:

  ./install.sh

If it needs to install system packages and passwordless sudo is not configured,
it will tell you the exact command to run first.

EOF
  exit 1
}

# better-sqlite3, which the bot depends on, has an install script of exactly
# "node-gyp rebuild" and no prebuilt-binary fallback. npm ci therefore needs a C/C++
# toolchain, make and python3 present, and node-gyp otherwise fails with a bare
# "not found: make". Minimal images and cloud defaults often ship without them.
ensure_build_toolchain() {
  local missing=() probe packages=()
  for probe in make python3; do
    command -v "$probe" >/dev/null 2>&1 || missing+=("$probe")
  done
  command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1 || missing+=("gcc")
  command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || missing+=("g++")

  if [[ ${#missing[@]} -eq 0 ]]; then
    return 0
  fi

  log "Native build tools are required by better-sqlite3. Missing: ${missing[*]}"

  if command -v apt-get >/dev/null 2>&1; then
    packages=(build-essential python3)
  elif command -v dnf >/dev/null 2>&1; then
    packages=("gcc-c++" make python3)
  elif command -v yum >/dev/null 2>&1; then
    packages=("gcc-c++" make python3)
  elif command -v zypper >/dev/null 2>&1; then
    packages=("gcc-c++" make python3)
  elif command -v pacman >/dev/null 2>&1; then
    packages=(base-devel python)
  elif command -v apk >/dev/null 2>&1; then
    packages=(build-base python3)
  elif command -v brew >/dev/null 2>&1; then
    log "On macOS install the command line tools first: xcode-select --install"
    return 0
  fi

  if [[ ${#packages[@]} -gt 0 ]]; then
    log "Installing: ${packages[*]}"
    pkg_install "${packages[@]}" || log "Package install did not succeed, re-checking below."
  fi

  missing=()
  for probe in make python3; do
    command -v "$probe" >/dev/null 2>&1 || missing+=("$probe")
  done
  command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1 || missing+=("gcc")
  command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || missing+=("g++")

  if [[ ${#missing[@]} -gt 0 ]]; then
    {
      echo
      echo "[installer] ERROR: npm ci cannot build better-sqlite3 without a native toolchain."
      echo "[installer] Still missing: ${missing[*]}"
      echo
      echo "Install them, then re-run the installer:"
      echo "  Debian / Ubuntu   sudo apt-get install -y build-essential python3"
      echo "  Fedora / RHEL     sudo dnf install -y gcc-c++ make python3"
      echo "  openSUSE           sudo zypper install gcc-c++ make python3"
      echo "  Arch               sudo pacman -S --needed base-devel python"
      echo "  Alpine             sudo apk add build-base python3"
      echo
    } >&2
    exit 1
  fi
}

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -p "process.versions.node.split('.')[0]" 2>/dev/null
}

node_is_supported() {
  local major
  major="$(node_major)" || return 1
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  (( major >= 22 ))
}

install_nodejs() {
  if node_is_supported; then
    log "Node $(node --version) already satisfies the required engine"
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    log "Node $(node --version 2>/dev/null || echo unknown) is older than the required ^22.14.0, replacing it"
  fi

  local asset_arch tmp target_dir
  asset_arch="$(uname -m)"
  [[ "$asset_arch" == "aarch64" || "$asset_arch" == "arm64" ]] && asset_arch="arm64"
  [[ "$asset_arch" == "x86_64" || "$asset_arch" == "amd64" ]] && asset_arch="x64"
  [[ "$asset_arch" == "x64" || "$asset_arch" == "arm64" ]] || die "No Node.js build for architecture: $(uname -m)"

  target_dir="$INSTALL_ROOT/bin"
  local node_root="$INSTALL_ROOT/node-v$NODE_VERSION"
  local archive_dir="node-v$NODE_VERSION-linux-$asset_arch"
  mkdir -p "$target_dir"

  local url="https://nodejs.org/dist/v$NODE_VERSION/$archive_dir.tar.xz"
  local tmp archive
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/opencode-node.XXXXXX")"
  archive="$tmp/node.tar.xz"

  log "Downloading Node.js $NODE_VERSION for $asset_arch"
  if [[ "$FETCH_CMD" == "wget" ]]; then
    wget -q "$url" -O "$archive" || die "Failed to download Node.js from $url"
  else
    curl -fsSL "$url" -o "$archive" || die "Failed to download Node.js from $url"
  fi

  tar -xJf "$archive" -C "$tmp" || die "Failed to unpack Node.js. Install xz-utils and re-run."

  # bin/npm and bin/npx are symlinks into ../lib/node_modules, and those entry points in
  # turn require files that sit beside them. Copying only bin/ dereferences the symlinks
  # and leaves npm as a standalone script whose relative require no longer resolves, so
  # the whole tree is copied with -a to keep the links intact.
  [[ -d "$tmp/$archive_dir" ]] || die "Unexpected Node.js archive layout: $archive_dir not found."
  rm -rf "$node_root"
  cp -a "$tmp/$archive_dir" "$node_root" || die "Failed to install Node.js into $node_root"
  rm -rf "$tmp"
  chmod 0755 "$node_root/bin/node"

  local entry
  for entry in node npm npx corepack; do
    [[ -e "$node_root/bin/$entry" ]] || continue
    ln -sfn "$node_root/bin/$entry" "$target_dir/$entry"
  done

  export PATH="$target_dir:$PATH"
  hash -r 2>/dev/null || true
  node_is_supported || die "Node.js $NODE_VERSION did not start correctly after install."
  log "Installed Node $(node --version) into $target_dir"
}

validate_placeholders() {
  local name value
  for name in TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USER_ID CF_WORKERS_AI_ACCOUNT CF_WORKERS_AI_TOKEN; do
    value="${!name}"
    [[ "$value" != REPLACE_WITH_* ]] || die "Replace $name in install.sh before running."
    [[ -n "$value" ]] || die "$name cannot be empty."
  done
  [[ "$TELEGRAM_ALLOWED_USER_ID" =~ ^[0-9]+$ ]] || die "TELEGRAM_ALLOWED_USER_ID must contain only digits."
  if [[ -n "$POSTIZ_MCP_URL" || -n "$POSTIZ_MCP_TOKEN" ]]; then
    [[ -n "$POSTIZ_MCP_URL" && -n "$POSTIZ_MCP_TOKEN" ]] || die "Set both POSTIZ_MCP_URL and POSTIZ_MCP_TOKEN, or leave both as placeholders."
    [[ "$POSTIZ_MCP_URL" =~ ^https?:// ]] || die "POSTIZ_MCP_URL must be an absolute http(s) URL."
  fi
}

check_platform() {
  [[ "$(uname -s)" == "Linux" ]] || die "This installer currently supports Linux user services only."
  [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "x86_64" || "$(uname -m)" == "arm64" ]] || die "Unsupported CPU architecture: $(uname -m)"
  command -v systemctl >/dev/null 2>&1 || die "systemctl is required."
  systemctl --user show-environment >/dev/null 2>&1 || die "A user systemd session is required. Log in and enable lingering for your user first."
}

install_opencode_binary() {
  local version="$1" destination="$2" url tmp asset_arch asset_suffix=""
  mkdir -p "$(dirname "$destination")"
  if [[ -x "$destination" ]] && "$destination" --version 2>/dev/null | grep -q "$version"; then
    log "OpenCode $version already installed at $destination"
    return
  fi
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/opencode-install.XXXXXX")"
  asset_arch="$(uname -m)"
  [[ "$asset_arch" == "aarch64" ]] && asset_arch="arm64"
  [[ "$asset_arch" == "x86_64" ]] && asset_arch="x64"
  if [[ "$asset_arch" == "x64" ]] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then
    asset_suffix="-baseline"
  fi
  if [[ "$asset_arch" == "x64" ]] && ldd --version 2>&1 | grep -qi musl; then
    asset_suffix="-musl"
  fi
  if [[ "$asset_arch" == "arm64" ]] && ldd --version 2>&1 | grep -qi musl; then
    asset_suffix="-musl"
  fi
  if [[ "$version" == "2.0.11" ]]; then
    url="https://opencode.ai/files/bin/$version/opencode-linux-$asset_arch$asset_suffix.tar.gz"
  else
    url="https://github.com/anomalyco/opencode/releases/download/v$version/opencode-linux-$asset_arch$asset_suffix.tar.gz"
  fi
  log "Downloading OpenCode $version"
  if [[ "$FETCH_CMD" == "wget" ]]; then
    wget -q "$url" -O "$tmp/opencode.tar.gz"
  else
    curl -fsSL "$url" -o "$tmp/opencode.tar.gz"
  fi
  tar -xzf "$tmp/opencode.tar.gz" -C "$tmp"
  install -m 0755 "$tmp/opencode" "$destination"
  rm -rf "$tmp"
  "$destination" --version | grep -q "$version" || die "Downloaded OpenCode version check failed."
}

copy_payload() {
  if [[ ! -d "$PAYLOAD_DIR/opencode-telegram-bot" ]]; then
    require_command curl
    require_command tar
    local archive_dir extracted_dir
    archive_dir="$(mktemp -d "${TMPDIR:-/tmp}/opencode-payload.XXXXXX")"
    if [[ "$FETCH_CMD" == "wget" ]]; then
      wget -q "$PAYLOAD_ARCHIVE_URL" -O "$archive_dir/installer.tar.gz"
    else
      curl -fsSL "$PAYLOAD_ARCHIVE_URL" -o "$archive_dir/installer.tar.gz"
    fi
    tar -xzf "$archive_dir/installer.tar.gz" -C "$archive_dir"
    extracted_dir="$(find "$archive_dir" -mindepth 1 -maxdepth 1 -type d -name 'opencode-telegram-installer-*' -print -quit)"
    [[ -n "$extracted_dir" ]] || die "Could not locate the downloaded installer payload."
    PAYLOAD_DIR="$extracted_dir/payload"
    rm -rf "$archive_dir"
  fi
  [[ -d "$PAYLOAD_DIR/opencode-telegram-bot" ]] || die "Installer payload is missing: $PAYLOAD_DIR/opencode-telegram-bot"
  mkdir -p "$INSTALL_ROOT"
  log "Installing Telegram bot source"

  # settings.json is bot state, not deployment output. In sources mode the bot resolves
  # its app home from its working directory, so this file holds the active persona, the
  # dismissed projects, the selected project and session, and any scheduled tasks.
  # Wiping it on every re-run silently threw all of that away, so it is carried across.
  local preserved_settings=""
  if [[ -f "$BOT_SOURCE_DIR/settings.json" ]]; then
    preserved_settings="$(mktemp "${TMPDIR:-/tmp}/opencode-settings.XXXXXX")"
    cp -a "$BOT_SOURCE_DIR/settings.json" "$preserved_settings"
  fi

  rm -rf "$BOT_SOURCE_DIR"
  mkdir -p "$BOT_SOURCE_DIR"
  cp -a "$PAYLOAD_DIR/opencode-telegram-bot/." "$BOT_SOURCE_DIR/"
  rm -rf "$BOT_SOURCE_DIR/node_modules" "$BOT_SOURCE_DIR/dist" "$BOT_SOURCE_DIR/logs" "$BOT_SOURCE_DIR/.env" "$BOT_SOURCE_DIR/settings.json" "$BOT_SOURCE_DIR/settings.json.bak"

  if [[ -n "$preserved_settings" ]]; then
    cp -a "$preserved_settings" "$BOT_SOURCE_DIR/settings.json"
    rm -f "$preserved_settings"
    log "Preserved existing bot settings"
  fi

  local npm_log="$INSTALL_ROOT/npm-install.log"
  mkdir -p "$INSTALL_ROOT"
  if ! (cd "$BOT_SOURCE_DIR" && npm ci --no-audit --no-fund) >"$npm_log" 2>&1; then
    # node-gyp output runs to hundreds of lines and buries the cause, so surface the
    # signal instead of dumping all of it.
    local hint=""
    grep -q 'not found: make' "$npm_log" && hint="make is missing"
    grep -q 'not found: g++\|not found: c++' "$npm_log" && hint="a C++ compiler is missing"
    grep -q 'not found: gcc\|not found: cc' "$npm_log" && hint="a C compiler is missing"
    grep -q 'Could not find python' "$npm_log" && hint="python3 is missing"
    grep -qE 'EACCES|Permission denied' "$npm_log" && hint="permission denied"
    {
      echo
      echo "[installer] ERROR: npm ci failed while building native modules."
      [[ -n "$hint" ]] && echo "[installer] Likely cause: $hint"
      echo "[installer] Full log: $npm_log"
      echo "[installer] Last lines:"
      tail -n 15 "$npm_log" | sed 's/^/[installer]   /'
      echo
    } >&2
    exit 1
  fi
  rm -f "$npm_log"

  if ! (cd "$BOT_SOURCE_DIR" && npm run build) >"$npm_log" 2>&1; then
    {
      echo
      echo "[installer] ERROR: building the Telegram bot failed."
      echo "[installer] Full log: $npm_log"
      tail -n 20 "$npm_log" | sed 's/^/[installer]   /'
      echo
    } >&2
    exit 1
  fi
  rm -f "$npm_log"
  log "Telegram bot built"
}

write_runtime_files() {
  local telegram_env main_env cloudflare_env telegram_server_env
  telegram_env="$BOT_SOURCE_DIR/.env"
  main_env="$INSTALL_ROOT/opencode-main.env"
  cloudflare_env="$INSTALL_ROOT/opencode-cloudflare.env"
  telegram_server_env="$INSTALL_ROOT/opencode-telegram-server.env"

  umask 077

  # The main and Telegram env files must share one password, so the value is generated
  # once up front and interpolated into both. Previously the Telegram env read it back
  # with a command substitution inside an unquoted heredoc whose quotes were backslash
  # escaped. A backslash before a double quote is not an escape in a heredoc, so awk
  # compared against the literal text "OPENCODE_SERVER_PASSWORD" and was handed a path
  # wrapped in literal quote characters. Both failures are silent, and the bot env ended
  # up with an empty password on every fresh install.
  local main_password
  main_password="$(openssl rand -hex 32)"
  [[ -n "$main_password" ]] || die "openssl failed to generate the server password."

  cat >"$main_env" <<EOF
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=$main_password
EOF

  cat >"$telegram_env" <<EOF
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USER_ID=$TELEGRAM_ALLOWED_USER_ID
OPENCODE_API_URL=$OPENCODE_TELEGRAM_URL
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=$main_password
OPENCODE_MODEL_PROVIDER=$OPENCODE_MODEL_PROVIDER
OPENCODE_MODEL_ID=$OPENCODE_MODEL_ID
BOT_LOCALE=vi
# "/" is the OpenCode server's default working directory and always shows up in
# /projects as the whole filesystem. Hiding it keeps the agent from running at the
# root when a real project is available. Add more paths, comma separated, to hide
# those too.
PROJECTS_EXCLUDED_PATHS=/
OPEN_BROWSER_ROOTS=$HOME
LOG_LEVEL=info
# Projects can also be hidden from the /projects menu, which stores the path in
# settings.dismissedProjects. Hiding is applied when the list is read, not by
# deleting the session-cache entry, because that cache is rebuilt from the
# OpenCode server on every ready refresh.
EOF
  cat >"$cloudflare_env" <<EOF
CF_WORKERS_AI_ACCOUNT=$CF_WORKERS_AI_ACCOUNT
CF_WORKERS_AI_TOKEN=$CF_WORKERS_AI_TOKEN
EOF
  if [[ -n "${POSTIZ_MCP_TOKEN:-}" && -n "${POSTIZ_MCP_URL:-}" ]]; then
    local postiz_api_url="${POSTIZ_MCP_URL%/mcp}"
    cat >"$INSTALL_ROOT/opencode-postiz.env" <<EOF
POSTIZ_MCP_TOKEN=$POSTIZ_MCP_TOKEN
POSTIZ_MCP_URL=$POSTIZ_MCP_URL
POSTIZ_API_URL=$postiz_api_url
EOF
  else
    : >"$INSTALL_ROOT/opencode-postiz.env"
  fi
  chmod 600 "$INSTALL_ROOT/opencode-postiz.env"
  cat >"$telegram_server_env" <<EOF
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=$(awk -F= '$1=="OPENCODE_SERVER_PASSWORD" {print $2}' "$main_env")
EOF
  chmod 600 "$telegram_env" "$main_env" "$cloudflare_env" "$telegram_server_env"
  unset OPENCODE_SERVER_PASSWORD
}

install_personas() {
  local telegram_root="$OPENCODE_TELEGRAM_CONFIG_DIR/opencode"
  local src="$PAYLOAD_DIR/personas"
  [[ -d "$src" ]] || return 0
  mkdir -p "$telegram_root/personas"

  # Personas are personal data, not deployment artefacts. The payload holds starter
  # templates; anything the user has already created or edited in the live library
  # is left untouched, so re-running the installer never clobbers their voice.
  local seeded=0
  local template
  for template in "$src"/*.md; do
    [[ -e "$template" ]] || continue
    local target="$telegram_root/personas/$(basename "$template")"
    if [[ -e "$target" ]]; then
      log "Persona exists, keeping your copy: $(basename "$template")"
      continue
    fi
    cp "$template" "$target"
    seeded=$((seeded + 1))
  done

  # `instructions` is the hook that puts the active persona into the system prompt.
  # The path must be resolvable by the OpenCode server: a relative entry is globbed
  # from the session working directory, not the config dir, so a home-relative path
  # is used instead.
  local persona_ref="~/$telegram_root/PERSONA.md"
  # Only create the overlay when absent. It holds the active persona, which the bot
  # rewrites on every switch, so truncating it here would reset the chosen voice.
  if [[ ! -e "$telegram_root/PERSONA.md" ]]; then
    : >"$telegram_root/PERSONA.md"
    chmod 600 "$telegram_root/PERSONA.md"
  fi
  if compgen -G "$telegram_root/personas/*.md" >/dev/null; then
    chmod 644 "$telegram_root/personas"/*.md
  fi

  if ! grep -q '"instructions"' "$telegram_root/opencode.jsonc" 2>/dev/null; then
    if grep -q '"\$schema"' "$telegram_root/opencode.jsonc" 2>/dev/null; then
      sed -i "0,\"\$schema\"/s||\"\$schema\": \"https://opencode.ai/config.json\",|\"\$schema\": \"https://opencode.ai/config.json\",\n  \"instructions\": [\"$persona_ref\"],|" "$telegram_root/opencode.jsonc"
    fi
  fi
  log "Persona library at $telegram_root/personas ($seeded starter(s) added, existing kept)"
  log "Persona hook: config.instructions -> $persona_ref"
}

install_postiz_agent() {
  local telegram_root="$OPENCODE_TELEGRAM_CONFIG_DIR/opencode"
  local src="$PAYLOAD_DIR/postiz-agent"
  [[ -d "$src" ]] || return 0
  mkdir -p "$telegram_root/agents" "$telegram_root/skills/postiz-guidance" "$telegram_root/tools"
  cp "$src/AGENTS.md" "$telegram_root/AGENTS.md"
  cp "$src/agents/postiz-social.md" "$telegram_root/agents/postiz-social.md"
  cp "$src/skills/postiz-guidance/SKILL.md" "$telegram_root/skills/postiz-guidance/SKILL.md"
  cp "$src/postiz_upload_image.ts" "$telegram_root/tools/postiz_upload_image.ts"
  chmod 644 "$telegram_root/AGENTS.md" "$telegram_root/agents/postiz-social.md" "$telegram_root/skills/postiz-guidance/SKILL.md" "$telegram_root/tools/postiz_upload_image.ts"
}

install_image_plugin() {
  local plugin_dir="$OPENCODE_MAIN_CONFIG_DIR/plugins/cloudflare-image"
  local telegram_plugin_dir="$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/tools"
  local skill_dir="$OPENCODE_MAIN_CONFIG_DIR/skills/cf-image-guidance"
  local telegram_skill_dir="$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/skills/cf-image-guidance"
  mkdir -p "$plugin_dir" "$telegram_plugin_dir" "$skill_dir" "$telegram_skill_dir" "$OPENCODE_MAIN_CONFIG_DIR"
  cp "$PAYLOAD_DIR/opencode-image-plugin/v2-plugin.js" "$plugin_dir/index.js"
  cp "$PAYLOAD_DIR/opencode-image-plugin/v1-tool.ts" "$telegram_plugin_dir/image_generate.ts"
  cp "$PAYLOAD_DIR/opencode-image-plugin/SKILL.md" "$skill_dir/SKILL.md"
  cp "$PAYLOAD_DIR/opencode-image-plugin/SKILL.md" "$telegram_skill_dir/SKILL.md"
  chmod 644 "$plugin_dir/index.js" "$telegram_plugin_dir/image_generate.ts" "$skill_dir/SKILL.md" "$telegram_skill_dir/SKILL.md"
  install_postiz_agent
  install_personas
  mkdir -p "$OPENCODE_MAIN_CONFIG_DIR" "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode"
  if [[ ! -f "$OPENCODE_MAIN_CONFIG_DIR/package.json" ]]; then
    printf '%s\n' '{"private":true,"type":"module"}' >"$OPENCODE_MAIN_CONFIG_DIR/package.json"
  fi
  if [[ ! -f "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/package.json" ]]; then
    printf '%s\n' '{"private":true,"type":"module"}' >"$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/package.json"
  fi
  npm install --prefix "$OPENCODE_MAIN_CONFIG_DIR" --no-audit --no-fund --save-exact @opencode/plugin@2.0.11 >/dev/null
  npm install --prefix "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode" --no-audit --no-fund --save-exact @opencode-ai/plugin@1.18.32 >/dev/null
  if [[ ! -f "$OPENCODE_MAIN_CONFIG_DIR/opencode.jsonc" && ! -f "$OPENCODE_MAIN_CONFIG_DIR/opencode.json" ]]; then
    cat >"$OPENCODE_MAIN_CONFIG_DIR/opencode.jsonc" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json"
}
EOF
  fi
  if [[ ! -f "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/opencode.jsonc" && ! -f "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/opencode.json" ]]; then
    cat >"$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/opencode.jsonc" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json"
}
EOF
  fi
  # Add the optional Postiz MCP server without overwriting unrelated config.
  if [[ -n "${POSTIZ_MCP_TOKEN:-}" && -n "${POSTIZ_MCP_URL:-}" ]]; then
    local postiz_url="${POSTIZ_MCP_URL:-}"
    # Use the OpenCode CLI so existing JSONC settings and MCP entries are preserved.
    HOME="$HOME" OPENCODE_CONFIG_DIR="$OPENCODE_MAIN_CONFIG_DIR" "$OPENCODE_MAIN_BIN_DIR/opencode" mcp add postiz --url "$postiz_url" --header 'Authorization=Bearer {env:POSTIZ_MCP_TOKEN}' --global >/dev/null
    HOME="$HOME" XDG_CONFIG_HOME="$OPENCODE_TELEGRAM_CONFIG_DIR" OPENCODE_CONFIG_DIR="$OPENCODE_TELEGRAM_CONFIG_DIR/opencode" "$OPENCODE_TELEGRAM_BIN_DIR/opencode" mcp add postiz --url "$postiz_url" --header 'Authorization=Bearer {env:POSTIZ_MCP_TOKEN}' >/dev/null
  fi
}

write_systemd_units() {
  mkdir -p "$USER_SYSTEMD_DIR"
  cat >"$USER_SYSTEMD_DIR/opencode.service" <<EOF
[Unit]
Description=OpenCode V2 server
After=network-online.target
Wants=network-online.target

[Service]
Environment=HOME=$HOME
Environment=OPENCODE_CONFIG_DIR=$OPENCODE_MAIN_CONFIG_DIR
EnvironmentFile=$INSTALL_ROOT/opencode-main.env
EnvironmentFile=$INSTALL_ROOT/opencode-cloudflare.env
EnvironmentFile=$INSTALL_ROOT/opencode-postiz.env
ExecStart=$OPENCODE_MAIN_BIN_DIR/opencode serve --hostname=127.0.0.1 --port=5100
Restart=always
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
EOF
  cat >"$USER_SYSTEMD_DIR/opencode-telegram-server.service" <<EOF
[Unit]
Description=OpenCode server for Telegram bot
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$HOME
Environment=HOME=$HOME
Environment=OPENCODE_CONFIG_DIR=$OPENCODE_TELEGRAM_CONFIG_DIR/opencode
Environment=XDG_CONFIG_HOME=$OPENCODE_TELEGRAM_CONFIG_DIR
Environment=XDG_DATA_HOME=$OPENCODE_TELEGRAM_DATA_DIR
Environment=XDG_STATE_HOME=$OPENCODE_TELEGRAM_STATE_DIR
Environment=XDG_CACHE_HOME=$OPENCODE_TELEGRAM_CACHE_DIR
EnvironmentFile=$INSTALL_ROOT/opencode-telegram-server.env
EnvironmentFile=$INSTALL_ROOT/opencode-cloudflare.env
EnvironmentFile=$INSTALL_ROOT/opencode-postiz.env
ExecStart=$OPENCODE_TELEGRAM_BIN_DIR/opencode serve --hostname=127.0.0.1 --port=4096
Restart=always
RestartSec=3
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=default.target
EOF
  cat >"$USER_SYSTEMD_DIR/opencode-telegram-bot.service" <<EOF
[Unit]
Description=OpenCode Telegram Bot
Wants=network-online.target opencode-telegram-server.service
After=network-online.target opencode-telegram-server.service

[Service]
Type=simple
WorkingDirectory=$BOT_SOURCE_DIR
Environment=HOME=$HOME
Environment=OPENCODE_CONFIG_DIR=$OPENCODE_TELEGRAM_CONFIG_DIR/opencode
Environment=XDG_CONFIG_HOME=$HOME/.config
Environment=PATH=$INSTALL_ROOT/bin:$OPENCODE_TELEGRAM_BIN_DIR:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
EnvironmentFile=$BOT_SOURCE_DIR/.env
EnvironmentFile=$INSTALL_ROOT/opencode-telegram-server.env
ExecStart=$(command -v node) $BOT_SOURCE_DIR/dist/cli.js start --mode sources
Restart=always
RestartSec=5
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=default.target
EOF
  chmod 644 "$USER_SYSTEMD_DIR/opencode.service" "$USER_SYSTEMD_DIR/opencode-telegram-server.service" "$USER_SYSTEMD_DIR/opencode-telegram-bot.service"
}

start_services() {
  systemctl --user daemon-reload
  systemctl --user enable opencode.service opencode-telegram-server.service opencode-telegram-bot.service
  systemctl --user restart opencode.service opencode-telegram-server.service opencode-telegram-bot.service
  sleep 3
  systemctl --user is-active --quiet opencode.service || die "opencode.service did not start."
  systemctl --user is-active --quiet opencode-telegram-server.service || die "opencode-telegram-server.service did not start."
  systemctl --user is-active --quiet opencode-telegram-bot.service || die "opencode-telegram-bot.service did not start."
}

main() {
  refuse_root
  ensure_bootstrap_tools
  install_nodejs
  require_command npm
  ensure_build_toolchain
  validate_placeholders
  check_platform
  install_opencode_binary "$OPENCODE_MAIN_VERSION" "$OPENCODE_MAIN_BIN_DIR/opencode"
  install_opencode_binary "$OPENCODE_TELEGRAM_VERSION" "$OPENCODE_TELEGRAM_BIN_DIR/opencode"
  copy_payload
  write_runtime_files
  install_image_plugin
  write_systemd_units
  start_services
  log "Installed OpenCode, the Telegram bot, the Cloudflare image tool, and user services."
  log "Main OpenCode: $OPENCODE_MAIN_URL"
  log "Telegram OpenCode: $OPENCODE_TELEGRAM_URL"
  log "Edit $SCRIPT_DIR/install.sh placeholders for future installs; never commit real credentials."
}

main "$@"
